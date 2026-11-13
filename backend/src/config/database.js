'use strict';

const mongoose = require('mongoose');
const config = require('./env');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

let listenersAttached = false;

function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (error) => logger.error('MongoDB connection error', { error }));
}

/**
 * Opens the shared Mongoose connection. Fails fast (after ~5s) if MongoDB is
 * unreachable so the process does not start in a broken state.
 */
async function connectDatabase(uri = config.mongodb.uri) {
  attachListeners();
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
    autoIndex: !config.isProduction,
  });
  logger.info('MongoDB connected', { database: mongoose.connection.name });
  return mongoose.connection;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}

function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

async function pingDatabase() {
  if (!isDatabaseConnected()) throw new Error('MongoDB is not connected');
  await mongoose.connection.db.admin().ping();
}

module.exports = { connectDatabase, disconnectDatabase, isDatabaseConnected, pingDatabase };
