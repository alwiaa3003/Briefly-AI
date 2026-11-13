'use strict';

const mongoose = require('mongoose');

/**
 * Intermediate map-step state for long documents: the structured notes produced
 * for one chunk (a range of parts). Kept only while the job runs, so a retry
 * resumes without re-summarizing finished chunks; deleted once the final
 * summary is saved.
 */
const documentChunkSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },
    index: { type: Number, required: true, min: 0 },
    partStart: { type: Number, required: true, min: 0 },
    partEnd: { type: Number, required: true, min: 0 }, // inclusive
    notes: { type: mongoose.Schema.Types.Mixed, required: true },
    usage: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

documentChunkSchema.index({ source: 1, index: 1 }, { unique: true });

module.exports = mongoose.models.DocumentChunk || mongoose.model('DocumentChunk', documentChunkSchema);
