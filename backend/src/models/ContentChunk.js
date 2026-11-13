'use strict';

const mongoose = require('mongoose');
const { SOURCE_KINDS } = require('../queues/constants');

/**
 * A retrievable passage of a source (article text, a run of transcript
 * segments, or part of a document page/section), with its embedding.
 *
 * Retrieval ALWAYS filters by `user` (Atlas Vector Search pre-filter and a
 * second $match afterwards), so one user's chunks can never be returned for
 * another user. `user`, `source`, `kind` and `sourceCreatedAt` are declared
 * as filter fields in the Atlas vector index (see scripts/rag-create-index.js).
 *
 * The embedding is excluded from queries unless explicitly selected.
 */
const contentChunkSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },
    kind: { type: String, enum: Object.values(SOURCE_KINDS), required: true },
    sourceCreatedAt: { type: Date, required: true },
    index: { type: Number, required: true, min: 0 },
    // 'content' = the source itself; 'summary' = the generated summary (helps broad questions).
    chunkType: { type: String, enum: ['content', 'summary'], default: 'content' },
    text: { type: String, required: true, maxlength: 8000 },
    // sha256 of text: identical text is embedded once and vectors are reused when re-indexing.
    textHash: { type: String, default: null, maxlength: 64 },
    // Human-readable locator shown with citations, e.g. "p. 4", "12:30–13:05", "Methods".
    label: { type: String, default: null, maxlength: 120 },
    page: { type: Number, default: null },
    section: { type: String, default: null, maxlength: 300 },
    startSeconds: { type: Number, default: null },
    endSeconds: { type: Number, default: null },
    embedding: { type: [Number], default: undefined, select: false },
    embeddingModel: { type: String, default: null, maxlength: 100 },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.user;
        delete ret.embedding;
        if (ret.source) ret.source = ret.source.toString();
        return ret;
      },
    },
  }
);

contentChunkSchema.index({ source: 1, index: 1 }, { unique: true });
contentChunkSchema.index({ user: 1, source: 1 });
contentChunkSchema.index({ source: 1, textHash: 1 });
// Keyword half of hybrid search. The equality prefix on `user` keeps text search per user.
contentChunkSchema.index({ user: 1, text: 'text' }, { default_language: 'none', name: 'user_text' });

module.exports = mongoose.models.ContentChunk || mongoose.model('ContentChunk', contentChunkSchema);
