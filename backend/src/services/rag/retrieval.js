'use strict';

/**
 * Hybrid retrieval: semantic (vector) + keyword ($text) results merged with
 * reciprocal rank fusion. Semantic search needs the embedding service; when it
 * is unavailable (e.g. AI not configured or quota used up) retrieval degrades to
 * keyword only and says so (`mode: 'keyword'`).
 *
 * Relevance: every candidate gets a semantic score on one scale (cosine similarity
 * mapped to 0..1, the scale of Atlas vectorSearchScore). Keyword-only matches are
 * scored against the query vector too, so `minScore` filters both lanes consistently.
 *
 * Every query is scoped to one user (see vectorStore.buildFilter).
 */

const crypto = require('crypto');
const config = require('../../config/env');
const ContentChunk = require('../../models/ContentChunk');
const processingClient = require('../processingClient');
const { embedResultSchema } = require('../../validators/aiValidators');
const vectorStore = require('./vectorStore');
const logger = require('../../utils/logger');

const RRF_K = 60;

/* Query vectors are cached per user (repeated / refined searches cost no embedding request). */
const QUERY_CACHE_MAX = 500;
const QUERY_CACHE_TTL_MS = 30 * 60 * 1000;
const queryCache = new Map();

function cacheKey(userId, query) {
  return `${userId}:${crypto.createHash('sha256').update(query.trim().toLowerCase()).digest('hex')}`;
}

async function embedQuery(query, userId) {
  const key = userId ? cacheKey(String(userId), query) : null;
  const hit = key ? queryCache.get(key) : null;
  if (hit && hit.expires > Date.now()) return hit.vector;

  const raw = await processingClient.embedTexts({ texts: [query.slice(0, 2000)], task: 'query' });
  const parsed = embedResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.vectors[0].length !== config.rag.embeddingDimensions) {
    const error = new Error('The embedding service returned an unexpected vector.');
    error.code = 'EMBEDDING_INVALID_RESPONSE';
    throw error;
  }
  const vector = parsed.data.vectors[0];
  if (key) {
    if (queryCache.size >= QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
    queryCache.set(key, { vector, expires: Date.now() + QUERY_CACHE_TTL_MS });
  }
  return vector;
}

async function keywordSearch(filter, query, limit) {
  try {
    return await ContentChunk.find({ ...filter, $text: { $search: query } }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .lean();
  } catch (error) {
    logger.warn('Keyword search failed', { error: { message: error.message, code: error.code } });
    return [];
  }
}

/** Semantic scores (0..1) for keyword-only matches, from their stored vectors. */
async function scoreRows(rows, queryVector, owner) {
  if (!rows.length) return new Map();
  const stored = await ContentChunk.find({ _id: { $in: rows.map((r) => r._id) }, user: owner })
    .select('+embedding')
    .lean();
  return new Map(
    stored
      .filter((row) => row.embedding?.length === queryVector.length)
      .map((row) => [String(row._id), vectorStore.toRelevance(vectorStore.dot(row.embedding, queryVector))])
  );
}

function fuse(lists, limit) {
  const merged = new Map();
  for (const list of lists) {
    list.forEach((row, rank) => {
      const key = String(row._id);
      const entry = merged.get(key) || { row, rrf: 0, semantic: null, keyword: false };
      entry.rrf += 1 / (RRF_K + rank + 1);
      if (row.store) entry.semantic = row.score;
      else entry.keyword = true;
      merged.set(key, entry);
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ row, rrf, semantic, keyword }) => ({ ...row, score: rrf, semanticScore: semantic, keywordMatch: keyword }));
}

/**
 * @param {object} options
 * @param {number} [options.minScore] minimum semantic relevance (0..1); 0 disables filtering.
 *   Applied only when a query vector exists; keyword-only mode cannot score meaning and keeps keyword matches.
 * @returns {{ chunks: object[], mode: 'hybrid'|'keyword', degradedReason?: string }}
 */
async function retrieve({ userId, query, sourceIds, kinds, from, to, limit = config.rag.topK, semantic = true, minScore = 0 }) {
  const filter = vectorStore.buildFilter({ userId, sourceIds, kinds, from, to });
  const keywordPromise = keywordSearch(filter, query, limit * 2);

  let semanticRows = [];
  let mode = 'hybrid';
  let degradedReason;
  let queryVector = null;
  if (semantic) {
    try {
      queryVector = await embedQuery(query, userId);
      semanticRows = await vectorStore.search({ userId, queryVector, sourceIds, kinds, from, to, limit: limit * 2 });
    } catch (error) {
      mode = 'keyword';
      queryVector = null;
      degradedReason = error.code || 'SEMANTIC_UNAVAILABLE';
      logger.warn('Semantic retrieval unavailable; using keyword search only', { code: error.code });
    }
  } else {
    mode = 'keyword';
  }

  const keywordRows = await keywordPromise;
  let chunks = fuse([semanticRows, keywordRows], limit * 2).filter((row) => String(row.user) === String(filter.user));

  if (queryVector) {
    const unscored = chunks.filter((row) => row.semanticScore === null);
    const scores = await scoreRows(unscored, queryVector, filter.user);
    chunks = chunks.map((row) => (row.semanticScore === null ? { ...row, semanticScore: scores.get(String(row._id)) ?? null } : row));
    if (minScore > 0) chunks = chunks.filter((row) => row.semanticScore !== null && row.semanticScore >= minScore);
  }
  return { chunks: chunks.slice(0, limit), mode, ...(degradedReason && { degradedReason }) };
}

function __clearQueryCache() {
  queryCache.clear();
}

module.exports = { retrieve, embedQuery, fuse, __clearQueryCache };
