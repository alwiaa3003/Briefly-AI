'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { connectDatabase, disconnectDatabase } = require('../../src/config/database');

let server = null;

/** Starts a throwaway in-memory MongoDB and connects Mongoose to it. */
async function startTestDatabase() {
  server = await MongoMemoryServer.create();
  await connectDatabase(server.getUri('briefly_test'));
  await mongoose.connection.syncIndexes();
}

async function clearTestDatabase() {
  const collections = Object.values(mongoose.connection.collections);
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
}

async function stopTestDatabase() {
  await disconnectDatabase();
  if (server) {
    await server.stop();
    server = null;
  }
}

module.exports = { startTestDatabase, clearTestDatabase, stopTestDatabase };
