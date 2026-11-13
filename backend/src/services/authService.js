'use strict';

const bcrypt = require('bcrypt');
const config = require('../config/env');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');

const DUPLICATE_KEY_ERROR = 11000;

let dummyHashPromise = null;

/**
 * A fixed hash compared against when the email does not exist, so a failed
 * login takes roughly the same time whether or not the account exists.
 */
function getDummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash('briefly-timing-equalizer', config.auth.bcryptSaltRounds);
  }
  return dummyHashPromise;
}

function hashPassword(password) {
  return bcrypt.hash(password, config.auth.bcryptSaltRounds);
}

function emailInUseError() {
  return ApiError.conflict('An account with this email already exists.', 'EMAIL_IN_USE');
}

async function registerUser({ name, email, password }) {
  const existing = await User.exists({ email });
  if (existing) throw emailInUseError();

  const passwordHash = await hashPassword(password);
  try {
    return await User.create({ name, email, passwordHash });
  } catch (error) {
    // Two concurrent registrations can both pass the check above; the unique
    // index is the real guarantee.
    if (error && error.code === DUPLICATE_KEY_ERROR) throw emailInUseError();
    throw error;
  }
}

async function authenticateUser({ email, password }) {
  const user = await User.findOne({ email }).select('+passwordHash');
  const hash = user ? user.passwordHash : await getDummyHash();
  const matches = await bcrypt.compare(password, hash);

  if (!user || !matches) {
    throw ApiError.unauthorized('Invalid email or password.', 'INVALID_CREDENTIALS');
  }
  return user;
}

async function getUserById(userId) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized('Your account could not be found.', 'USER_NOT_FOUND');
  return user;
}

module.exports = { registerUser, authenticateUser, getUserById, hashPassword };
