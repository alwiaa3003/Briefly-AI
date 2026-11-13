'use strict';

const mongoose = require('mongoose');
const { GENERATION_STATUSES } = require('../queues/constants');

/** A resolved reference into a source: where a statement comes from. */
const refSchema = new mongoose.Schema(
  {
    label: { type: String, default: null, maxlength: 120 },
    page: { type: Number, default: null },
    section: { type: String, default: null, maxlength: 300 },
    startSeconds: { type: Number, default: null },
  },
  { _id: false }
);

const errorSchema = new mongoose.Schema({ code: String, message: String, nextAttemptAt: Date }, { _id: false });

/** Fields shared by every generated study artifact (status of its background job, provenance). */
function generationFields() {
  return {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },
    status: {
      type: String,
      enum: Object.values(GENERATION_STATUSES),
      default: GENERATION_STATUSES.QUEUED,
      required: true,
    },
    error: { type: errorSchema, default: null },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcessingJob', default: null },
    model: { type: String, default: null, maxlength: 100 },
    promptVersion: { type: String, default: null, maxlength: 50 },
    inputCharacters: { type: Number, default: null },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
    generatedAt: { type: Date, default: null },
    // Source content (Source.rag.contentHash) this item was generated from; a different
    // current hash means the source changed and the item is regenerated on the next request.
    sourceContentHash: { type: String, default: null, maxlength: 64 },
  };
}

function baseTransform(_doc, ret) {
  ret.id = ret._id.toString();
  delete ret._id;
  delete ret.user;
  delete ret.job;
  delete ret.usage;
  delete ret.sourceContentHash;
  if (ret.source && ret.source.toString) ret.source = ret.source.toString();
  return ret;
}

module.exports = { refSchema, errorSchema, generationFields, baseTransform };
