'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const RefreshToken = require('../models/RefreshToken');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const JWT_ALGORITHM = 'HS256';
const DAY_MS = 24 * 60 * 60 * 1000;
const REUSE_GRACE_PERIOD_MS = 30 * 1000;

/* ---------------------------- Access tokens ---------------------------- */

/** Short-lived JWT. The frontend keeps it in memory only (never in storage). */
function signAccessToken(userId) {
  return jwt.sign({}, config.auth.accessTokenSecret, {
    algorithm: JWT_ALGORITHM,
    subject: String(userId),
    expiresIn: config.auth.accessTokenExpiresIn,
    issuer: config.auth.issuer,
    audience: config.auth.audience,
  });
}

/** Returns the user id encoded in a valid access token, or throws a 401 ApiError. */
function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, config.auth.accessTokenSecret, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.auth.issuer,
      audience: config.auth.audience,
    });
    if (!payload.sub) throw new Error('Missing subject');
    return payload.sub;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Your session has expired.', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid authentication token.', 'INVALID_TOKEN');
  }
}

/* ---------------------------- Refresh tokens --------------------------- */

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshTokenMaxAgeMs() {
  return config.auth.refreshTokenTtlDays * DAY_MS;
}

/** Issues a new opaque refresh token for the user and stores its hash. */
async function issueRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({
    user: userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + refreshTokenMaxAgeMs()),
  });
  return token;
}

/**
 * Exchanges a valid refresh token for a new one (rotation).
 * The old token is revoked atomically so it can only be used once.
 */
async function rotateRefreshToken(token) {
  if (!token || typeof token !== 'string') {
    throw ApiError.unauthorized('No active session.', 'NO_SESSION');
  }

  const tokenHash = hashToken(token);
  const now = new Date();

  const current = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now } },
    { new: true }
  );

  if (!current) {
    const previous = await RefreshToken.findOne({ tokenHash });
    // Tokens revoked moments ago are usually a benign race (two tabs refreshing
    // at once), so only older replays are treated as theft.
    const isSuspiciousReplay =
      previous && previous.revokedAt && now.getTime() - previous.revokedAt.getTime() > REUSE_GRACE_PERIOD_MS;
    if (isSuspiciousReplay) {
      // A revoked token was replayed: assume it was stolen and end all sessions.
      await RefreshToken.updateMany({ user: previous.user, revokedAt: null }, { $set: { revokedAt: now } });
      logger.warn('Refresh token reuse detected; all sessions revoked', { userId: previous.user.toString() });
    }
    throw ApiError.unauthorized('Your session has expired. Please sign in again.', 'INVALID_SESSION');
  }

  const newToken = await issueRefreshToken(current.user);
  return { userId: current.user.toString(), refreshToken: newToken };
}

async function revokeRefreshToken(token) {
  if (!token || typeof token !== 'string') return;
  await RefreshToken.updateOne({ tokenHash: hashToken(token), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  refreshTokenMaxAgeMs,
  hashToken,
  REUSE_GRACE_PERIOD_MS,
};
