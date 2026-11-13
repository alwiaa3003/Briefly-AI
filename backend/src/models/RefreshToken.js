'use strict';

const mongoose = require('mongoose');

/**
 * Server-side record of an issued refresh token.
 *
 * Only a SHA-256 hash of the token is stored, so a database leak does not
 * expose usable tokens. Tokens are single-use: each refresh revokes the old
 * token and issues a new one. Presenting an already-revoked token is treated
 * as theft and revokes every session of that user.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
// MongoDB removes expired tokens automatically.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RefreshToken || mongoose.model('RefreshToken', refreshTokenSchema);
