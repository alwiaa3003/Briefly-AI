'use strict';

const config = require('../config/env');
const authService = require('../services/authService');
const tokenService = require('../services/tokenService');
const { sendSuccess } = require('../utils/http');

/**
 * The refresh token lives in an httpOnly cookie scoped to /api/auth, so it is
 * never readable by JavaScript and is only sent to the auth endpoints.
 */
function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: config.auth.cookieSecure,
    sameSite: 'strict',
    path: '/api/auth',
  };
}

function setRefreshCookie(res, token) {
  res.cookie(config.auth.refreshCookieName, token, {
    ...refreshCookieOptions(),
    maxAge: tokenService.refreshTokenMaxAgeMs(),
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(config.auth.refreshCookieName, refreshCookieOptions());
}

async function startSession(res, user, statusCode) {
  const refreshToken = await tokenService.issueRefreshToken(user.id);
  setRefreshCookie(res, refreshToken);
  return sendSuccess(res, statusCode, {
    user: user.toJSON(),
    accessToken: tokenService.signAccessToken(user.id),
  });
}

/** POST /api/auth/register */
async function register(req, res) {
  const user = await authService.registerUser(req.body);
  return startSession(res, user, 201);
}

/** POST /api/auth/login */
async function login(req, res) {
  const user = await authService.authenticateUser(req.body);
  return startSession(res, user, 200);
}

/** GET /api/auth/me */
async function me(req, res) {
  const user = await authService.getUserById(req.auth.userId);
  return sendSuccess(res, 200, { user: user.toJSON() });
}

/** POST /api/auth/refresh — rotates the refresh cookie and returns a new access token. */
async function refresh(req, res) {
  const currentToken = req.cookies[config.auth.refreshCookieName];
  try {
    const { userId, refreshToken } = await tokenService.rotateRefreshToken(currentToken);
    const user = await authService.getUserById(userId);
    setRefreshCookie(res, refreshToken);
    return sendSuccess(res, 200, { user: user.toJSON(), accessToken: tokenService.signAccessToken(user.id) });
  } catch (error) {
    clearRefreshCookie(res);
    throw error;
  }
}

/** POST /api/auth/logout — revokes the current refresh token. Idempotent. */
async function logout(req, res) {
  await tokenService.revokeRefreshToken(req.cookies[config.auth.refreshCookieName]);
  clearRefreshCookie(res);
  return sendSuccess(res, 200, { loggedOut: true });
}

module.exports = { register, login, me, refresh, logout };
