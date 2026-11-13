'use strict';

const mongoose = require('mongoose');
const { JOB_TYPES, JOB_STATUSES } = require('../queues/constants');

/**
 * Durable, user-visible record of a background job.
 *
 * BullMQ keeps transient queue state in Redis (and expires it); this document
 * is the long-lived source of truth the API exposes to clients. Future
 * summarization jobs will reference Source/Summary documents from `input`
 * and `result`.
 */
const processingJobSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(JOB_TYPES), required: true },
    // The Source this job processes (null for infrastructure test jobs).
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', default: null },
    status: {
      type: String,
      enum: Object.values(JOB_STATUSES),
      default: JOB_STATUSES.QUEUED,
      required: true,
    },
    input: { type: mongoose.Schema.Types.Mixed, default: {} },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true, min: 1 },
    error: {
      type: new mongoose.Schema({ code: String, message: String }, { _id: false }),
      default: null,
    },
    // Set while the job waits for AI capacity (delayed retry); see workers/processor.js.
    nextAttemptAt: { type: Date, default: null },
    aiDeferrals: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    minimize: false,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.user;
        if (ret.source) ret.source = ret.source.toString();
        return ret;
      },
    },
  }
);

processingJobSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.ProcessingJob || mongoose.model('ProcessingJob', processingJobSchema);
