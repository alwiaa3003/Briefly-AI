'use strict';

/**
 * Vector similarity search over ContentChunk embeddings.
 *
 *   atlas - MongoDB Atlas Vector Search ($vectorSearch). Evaluated first and chosen
 *           (no extra database or service; see docs/ARCHITECTURE.md, "Vector search").
 *   exact - exact cosine similarity computed in-process over the user's chunks.
 *           Used by unit tests (mongodb-memory-server has no vector search) and as a
 *           fallback when the Atlas index does not exist yet. Bounded by RAG_EXACT_SCAN_LIMIT.
 *   auto  - atlas when the index exists and is queryable, exact otherwise (checked every 5 min).
 *
 * Security: every search requires a userId. The Atlas query pre-filters on `user`
 * inside $vectorSearch AND re-checks it with $match; the exact store filters in the
 * database query. A missing userId throws instead of searching everything.
 */

const mongoose = require('mongoose');
const config = require('../../config/env');
const ContentChunk = require('../../models/ContentChunk');
const logger = require('../../utils/logger');

const STATUS_TTL_MS = 5 * 60 * 1000;
let atlasStatus = { checkedAt: 0, usable: false };

function toObjectId(id) {
  return id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id));
}

/** Database filter shared by both stores. Always includes the owner. */
function buildFilter({ userId, sourceIds, kinds, from, to }) {
  if (!userId) throw new Error('vectorStore: userId is required for every search');
  const filter = { user: toObjectId(userId) };
  if (sourceIds?.length) filter.source = { $in: sourceIds.map(toObjectId) };
  if (kinds?.length) filter.kind = { $in: kinds };
  if (from || to) {
    filter.sourceCreatedAt = {};
    if (from) filter.sourceCreatedAt.$gte = from;
    if (to) filter.sourceCreatedAt.$lte = to;
  }
  return filter;
}

/** Cosine similarity (-1..1) mapped to 0..1, the same scale as Atlas vectorSearchScore for cosine indexes. */
function toRelevance(cosine) {
  return (1 + cosine) / 2;
}

function dot(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

async function exactSearch(filter, queryVector, limit) {
  const rows = await ContentChunk.find({ ...filter, embedding: { $exists: true } })
    .select('+embedding')
    .limit(config.rag.exactScanLimit)
    .lean();
  return rows
    .filter((row) => row.embedding?.length === queryVector.length)
    .map(({ embedding, ...row }) => ({ ...row, score: toRelevance(dot(embedding, queryVector)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function atlasSearch(filter, queryVector, limit) {
  const rows = await ContentChunk.aggregate([
    {
      $vectorSearch: {
        index: config.rag.vectorIndexName,
        path: 'embedding',
        queryVector,
        numCandidates: Math.max(config.rag.numCandidates, limit * 10),
        limit,
        filter,
      },
    },
    // Defence in depth: never trust the index filter alone for ownership.
    { $match: { user: filter.user } },
    { $project: { embedding: 0 } },
    { $addFields: { score: { $meta: 'vectorSearchScore' } } },
  ]);
  return rows;
}

/** Whether the Atlas vector index exists and is queryable (cached). */
async function isAtlasUsable({ force = false } = {}) {
  if (!force && Date.now() - atlasStatus.checkedAt < STATUS_TTL_MS) return atlasStatus.usable;
  let usable = false;
  try {
    const indexes = await ContentChunk.collection.listSearchIndexes(config.rag.vectorIndexName).toArray();
    usable = indexes.some((index) => index.queryable === true);
  } catch {
    usable = false; // not Atlas (e.g. local MongoDB / tests)
  }
  if (usable !== atlasStatus.usable || !atlasStatus.checkedAt) {
    logger.info(`Vector store: ${usable ? 'Atlas Vector Search' : 'exact in-process search'} (VECTOR_STORE=${config.rag.vectorStore})`);
  }
  atlasStatus = { checkedAt: Date.now(), usable };
  return usable;
}

async function activeStore() {
  if (config.rag.vectorStore === 'atlas') return 'atlas';
  if (config.rag.vectorStore === 'exact') return 'exact';
  return (await isAtlasUsable()) ? 'atlas' : 'exact';
}

/**
 * Returns the `limit` chunks most similar to queryVector among the user's chunks
 * (optionally restricted to sources / kinds / a sourceCreatedAt range), each with `score`.
 */
async function search({ userId, queryVector, sourceIds, kinds, from, to, limit = config.rag.topK }) {
  const filter = buildFilter({ userId, sourceIds, kinds, from, to });
  const store = await activeStore();
  const rows = store === 'atlas' ? await atlasSearch(filter, queryVector, limit) : await exactSearch(filter, queryVector, limit);
  const owner = String(filter.user);
  // Final ownership assertion: drop anything that is not the caller's (should never happen).
  return rows.filter((row) => String(row.user) === owner).map((row) => ({ ...row, store }));
}

function resetVectorStoreStatus() {
  atlasStatus = { checkedAt: 0, usable: false };
}

module.exports = { search, buildFilter, isAtlasUsable, activeStore, resetVectorStoreStatus, dot, toRelevance };
