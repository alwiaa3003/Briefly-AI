'use strict';

const crypto = require('crypto');
const { UnrecoverableError } = require('bullmq');
const Source = require('../../models/Source');
const ContentChunk = require('../../models/ContentChunk');
const processingClient = require('../../services/processingClient');
const { ProcessingServiceError } = processingClient;
const aiGate = require('../../services/ai/aiGate');
const { loadSourceContent, chunksFor } = require('../../services/rag/sourceContent');
const { embedResultSchema } = require('../../validators/aiValidators');
const config = require('../../config/env');
const { RAG_STATUSES, SOURCE_STATUSES } = require('../../queues/constants');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function setRag(sourceId, fields) {
  const $set = {};
  for (const [key, value] of Object.entries(fields)) $set[`rag.${key}`] = value;
  return Source.updateOne({ _id: sourceId }, { $set });
}

/** Identifies the chunked content (and chunking settings): unchanged hash = nothing to re-embed. */
function contentHashOf(chunks) {
  return sha(JSON.stringify([config.rag.chunkChars, config.rag.chunkOverlapChars, chunks.map((c) => c.textHash)]));
}

/**
 * index_source job:
 *   1. chunk the stored content (article text / transcript / document parts + the summary)
 *   2. save ContentChunk documents (keyword search works from here on)
 *   3. embed chunks in batches and store the vectors
 *
 * Gemini usage is minimised:
 *   - an unchanged, fully indexed source is not touched at all (content hash);
 *   - when re-indexing, vectors of chunks whose text did not change are reused
 *     (same source, same user, same embedding model and dimensions);
 *   - identical texts are embedded once and the vector is shared.
 * Resumable: a retry keeps already embedded chunks and only embeds the rest.
 */
async function handleIndexSource({ input }) {
  const loaded = await loadSourceContent(input.sourceId, input.userId);
  if (!loaded) throw new UnrecoverableError('The source no longer exists.');
  const { source } = loaded;
  if (source.status !== SOURCE_STATUSES.COMPLETED) {
    throw new UnrecoverableError('Only completed sources can be indexed.');
  }

  const chunks = chunksFor(loaded).map((chunk) => ({ ...chunk, textHash: sha(chunk.text) }));
  const contentHash = contentHashOf(chunks);
  const [existingCount, existingEmbedded] = await Promise.all([
    ContentChunk.countDocuments({ source: source._id }),
    ContentChunk.countDocuments({ source: source._id, embedding: { $exists: true } }),
  ]);

  if (source.rag?.contentHash === contentHash && existingCount === chunks.length && existingEmbedded === existingCount) {
    await setRag(source._id, { status: RAG_STATUSES.READY, chunkCount: existingCount, embeddedCount: existingEmbedded, error: null });
    return { sourceId: source.id, chunkCount: existingCount, embeddedCount: existingEmbedded, reused: existingEmbedded, embedded: 0 };
  }

  await setRag(source._id, { status: RAG_STATUSES.INDEXING, error: null });

  let reused = 0;
  if (source.rag?.contentHash !== contentHash || existingCount !== chunks.length) {
    // Rebuild the chunks, carrying over vectors for unchanged text.
    const embeddingModel = (await aiGate.getModels()).embedding;
    const previous = await ContentChunk.find({ source: source._id, user: source.user })
      .select('+embedding text textHash embeddingModel')
      .lean();
    const vectors = new Map();
    for (const old of previous) {
      const usable =
        old.embedding?.length === config.rag.embeddingDimensions && old.embeddingModel && old.embeddingModel === embeddingModel;
      if (usable) vectors.set(old.textHash || sha(old.text), { embedding: old.embedding, embeddingModel: old.embeddingModel });
    }
    await ContentChunk.deleteMany({ source: source._id });
    if (chunks.length) {
      await ContentChunk.insertMany(
        chunks.map((chunk) => {
          const vector = vectors.get(chunk.textHash);
          if (vector) reused += 1;
          return {
            ...chunk,
            ...(vector || {}),
            user: source.user,
            source: source._id,
            kind: source.kind,
            sourceCreatedAt: source.createdAt,
          };
        }),
        { ordered: false }
      );
    }
    await setRag(source._id, { contentHash, chunkCount: chunks.length });
  }

  const chunkCount = await ContentChunk.countDocuments({ source: source._id });
  let model = null;
  let embedded = 0;
  for (;;) {
    // Distinct texts still missing a vector; each is embedded once and shared by all its chunks.
    const pending = await ContentChunk.aggregate([
      { $match: { source: source._id, embedding: { $exists: false } } },
      { $sort: { index: 1 } },
      { $group: { _id: '$textHash', text: { $first: '$text' }, first: { $first: '$index' } } },
      { $sort: { first: 1 } },
      { $limit: config.rag.embedBatchSize },
    ]);
    if (!pending.length) break;

    const raw = await processingClient.embedTexts({ texts: pending.map((c) => c.text), task: 'document' });
    const parsed = embedResultSchema.safeParse(raw);
    const valid =
      parsed.success &&
      parsed.data.vectors.length === pending.length &&
      parsed.data.vectors.every((v) => v.length === config.rag.embeddingDimensions);
    if (!valid) {
      throw new ProcessingServiceError('The embedding service returned vectors that do not match EMBEDDING_DIMENSIONS.', {
        code: 'EMBEDDING_INVALID_RESPONSE',
        retryable: false,
      });
    }
    model = parsed.data.model;
    embedded += pending.length;
    await ContentChunk.bulkWrite(
      pending.map((group, i) => ({
        updateMany: {
          filter: { source: source._id, user: source.user, textHash: group._id, embedding: { $exists: false } },
          update: { $set: { embedding: parsed.data.vectors[i], embeddingModel: model } },
        },
      }))
    );
    await setRag(source._id, {
      embeddedCount: await ContentChunk.countDocuments({ source: source._id, embedding: { $exists: true } }),
    });
  }

  const embeddedCount = await ContentChunk.countDocuments({ source: source._id, embedding: { $exists: true } });
  await setRag(source._id, {
    status: RAG_STATUSES.READY,
    chunkCount,
    embeddedCount,
    contentHash,
    model: model || source.rag?.model || null,
    dimensions: config.rag.embeddingDimensions,
    indexedAt: new Date(),
    error: null,
  });
  return { sourceId: source.id, chunkCount, embeddedCount, reused, embedded };
}

handleIndexSource.onDeferred = async ({ input, error }) => {
  await setRag(input.sourceId, { status: RAG_STATUSES.QUEUED, error });
};

handleIndexSource.onFinalFailure = async ({ input, error }) => {
  await setRag(input.sourceId, { status: RAG_STATUSES.FAILED, error });
};

module.exports = handleIndexSource;
