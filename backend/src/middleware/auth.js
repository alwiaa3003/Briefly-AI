'use strict';

const { verifyAccessToken } = require('../services/tokenService');
const ApiError = require('../utils/ApiError');

/**
 * Requires a valid "Authorization: Bearer <access token>" header.
 * Sets req.auth = { userId } for downstream handlers.
 */
function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthorized('Authentication is required.', 'UNAUTHORIZED'));
  }

  try {
    req.auth = { userId: verifyAccessToken(token) };
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { requireAuth };
