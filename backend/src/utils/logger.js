'use strict';

/**
 * Minimal structured logger.
 *
 * - Never logs request bodies.
 * - Redacts any metadata key that looks sensitive (passwords, tokens, secrets,
 *   cookies, authorization headers, API keys).
 * - JSON lines in production, readable lines in development.
 *
 * The level is read directly from LOG_LEVEL so the logger can be used before
 * (and independently of) configuration validation.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|hash/i;
const MAX_DEPTH = 4;

function currentLevel() {
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return level === 'silent' ? -1 : LEVELS[level] ?? LEVELS.info;
}

function serializeError(error) {
  const result = { name: error.name, message: error.message };
  if (error.code !== undefined) result.code = error.code;
  if (error.statusCode !== undefined) result.statusCode = error.statusCode;
  if (process.env.NODE_ENV !== 'production' && error.stack) result.stack = error.stack;
  return result;
}

function sanitize(value, depth = 0) {
  if (value instanceof Error) return serializeError(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[Redacted]' : sanitize(item, depth + 1);
  }
  return output;
}

function write(level, message, meta) {
  if (LEVELS[level] > currentLevel()) return;

  const safeMeta = meta === undefined ? undefined : sanitize(meta);
  const stream = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (process.env.NODE_ENV === 'production') {
    stream(JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...(safeMeta && { meta: safeMeta }) }));
    return;
  }

  const time = new Date().toISOString().slice(11, 23);
  const suffix = safeMeta === undefined ? '' : ` ${JSON.stringify(safeMeta)}`;
  stream(`${time} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`);
}

module.exports = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};
