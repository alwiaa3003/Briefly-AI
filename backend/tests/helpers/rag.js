'use strict';

/**
 * Test helpers for retrieval: a deterministic bag-of-words "embedding" (64 dims,
 * see tests/setup/testEnv.js) so similar texts really are close, plus seeding.
 */
const crypto = require('crypto');
const Source = require('../../src/models/Source');
const Summary = require('../../src/models/Summary');
const ContentChunk = require('../../src/models/ContentChunk');

const DIMS = 64;

function fakeVector(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (word.length < 3) continue;
    const bucket = crypto.createHash('md5').update(word).digest().readUInt32BE(0) % DIMS;
    vector[bucket] += 1;
  }
  const norm = Math.sqrt(vector.reduce((n, v) => n + v * v, 0)) || 1;
  return vector.map((v) => (norm === 1 && v === 0 ? 0 : v / norm));
}

/** Implementation for a mocked processingClient.embedTexts. */
async function fakeEmbedTexts({ texts }) {
  return { vectors: texts.map(fakeVector), model: 'fake-embedding', dimensions: DIMS, provider: 'fake' };
}

let counter = 0;
/** Creates a completed source with a summary and embedded chunks. */
async function seedIndexedSource(userId, { kind = 'article', title = 'Source', chunks = [], createdAt } = {}) {
  counter += 1;
  const source = await Source.create({
    user: userId,
    kind,
    submittedUrl: kind === 'article' || kind === 'youtube' ? `https://example.com/${counter}` : null,
    normalizedUrl: `seed:${counter}:${Date.now()}`,
    metadata: { title },
    status: 'completed',
    completedAt: new Date(),
    rag: { status: 'ready', chunkCount: chunks.length, embeddedCount: chunks.length },
    ...(kind === 'document' && { document: { format: 'pdf' } }),
    ...(createdAt && { createdAt }),
  });
  const summary = await Summary.create({
    user: userId,
    source: source._id,
    title,
    overview: `Overview of ${title} with enough characters.`,
    model: 'fake',
    promptVersion: 'v1',
  });
  await Source.updateOne({ _id: source._id }, { $set: { summary: summary._id } });
  await ContentChunk.insertMany(
    chunks.map((chunk, index) => {
      const c = typeof chunk === 'string' ? { text: chunk } : chunk;
      return {
        user: userId,
        source: source._id,
        kind,
        sourceCreatedAt: source.createdAt,
        index,
        label: c.label ?? `p. ${index + 1}`,
        page: c.page ?? (kind === 'document' ? index + 1 : null),
        startSeconds: c.startSeconds ?? null,
        text: c.text,
        embedding: fakeVector(c.text),
        embeddingModel: 'fake-embedding',
      };
    })
  );
  return source;
}

module.exports = { DIMS, fakeVector, fakeEmbedTexts, seedIndexedSource };
