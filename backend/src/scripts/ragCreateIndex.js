'use strict';

/**
 * npm run rag:create-index
 *
 * Creates (or updates) the MongoDB Atlas Vector Search index used by Ask AI and
 * smart search, then waits until it is queryable. Safe to run repeatedly.
 * Requires an Atlas cluster (M0 free tier works); on other MongoDB deployments
 * the backend uses the exact in-process store instead (VECTOR_STORE=auto|exact).
 */

const mongoose = require('mongoose');
const config = require('../config/env');
const { connectDatabase, disconnectDatabase } = require('../config/database');
const ContentChunk = require('../models/ContentChunk');

function indexDefinition() {
  return {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions: config.rag.embeddingDimensions, similarity: 'cosine' },
      { type: 'filter', path: 'user' },
      { type: 'filter', path: 'source' },
      { type: 'filter', path: 'kind' },
      { type: 'filter', path: 'sourceCreatedAt' },
    ],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await connectDatabase();
  const name = config.rag.vectorIndexName;
  const collectionName = ContentChunk.collection.collectionName;
  const existingCollections = await mongoose.connection.db.listCollections({ name: collectionName }).toArray();
  if (!existingCollections.length) await mongoose.connection.db.createCollection(collectionName);
  const collection = mongoose.connection.db.collection(collectionName);

  let indexes;
  try {
    indexes = await collection.listSearchIndexes(name).toArray();
  } catch (error) {
    throw new Error(`This MongoDB deployment does not support Atlas Vector Search (${error.codeName || error.message}).`);
  }

  const definition = indexDefinition();
  if (!indexes.length) {
    await collection.createSearchIndex({ name, type: 'vectorSearch', definition });
    console.log(`Created vector index "${name}" on ${collectionName} (${config.rag.embeddingDimensions} dimensions).`);
  } else {
    const current = indexes[0].latestDefinition || {};
    const dims = current.fields?.find((f) => f.type === 'vector')?.numDimensions;
    if (dims !== config.rag.embeddingDimensions || (current.fields || []).length !== definition.fields.length) {
      await collection.updateSearchIndex(name, definition);
      console.log(`Updated vector index "${name}" (dimensions ${dims} -> ${config.rag.embeddingDimensions}).`);
    } else {
      console.log(`Vector index "${name}" already exists with the expected definition.`);
    }
  }

  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    const [index] = await collection.listSearchIndexes(name).toArray();
    if (index?.queryable && index.status === 'READY') {
      console.log(`Vector index "${name}" is READY and queryable.`);
      break;
    }
    if (Date.now() > deadline) {
      console.log(`Vector index "${name}" is still ${index?.status || 'pending'}; it will become queryable shortly.`);
      break;
    }
    await sleep(5000);
  }
}

main()
  .catch((error) => {
    console.error(`rag:create-index failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
