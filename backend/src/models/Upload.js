'use strict';

const mongoose = require('mongoose');

/**
 * An uploaded file (video or document). The bytes live in object storage (never in MongoDB);
 * this document is the reference and the retention record.
 *
 * Retention: `expiresAt` is set at upload time (UPLOAD_RETENTION_DAYS) and
 * shortened when processing fails permanently (UPLOAD_FAILED_RETENTION_HOURS).
 * The hourly cleanup job deletes expired objects from storage and marks the
 * record `deleted`; transcripts and summaries are kept.
 *
 * Direct uploads (browser -> storage with a presigned URL) start as `pending` with the size
 * and type the browser declared; `expiresAt` is then the deadline for completing them. On
 * completion the server re-reads the object (`verifying`); only a verified object becomes
 * `stored`, anything else `rejected`. The cleanup job removes pending/rejected objects past expiry.
 */
const UPLOAD_STATUSES = Object.freeze(['pending', 'verifying', 'stored', 'rejected', 'deleted']);

const uploadSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', default: null },

    // Random, server-generated key. User input never becomes part of a storage path.
    // The object processing reads. For direct uploads it is never given to the browser: the
    // verified bytes are copied here, so a reused presigned URL cannot change them.
    storageKey: { type: String, required: true, maxlength: 300 },
    // Direct uploads only: the key the browser's presigned URL writes to. Removed after
    // completion, and again once the URL can no longer be used (uploadKeyPurgeAfter).
    uploadKey: { type: String, maxlength: 300, default: null },
    uploadKeyPurgeAfter: { type: Date, default: null },
    uploadKeyPurgedAt: { type: Date, default: null },
    // Display only (sanitized); never used to build paths.
    originalName: { type: String, required: true, maxlength: 200 },
    mimeType: { type: String, required: true, maxlength: 100 },
    // Detected format: video containers or document formats.
    container: { type: String, enum: ['mp4', 'mov', 'webm', 'mkv', 'pdf', 'docx', 'txt'], required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    // Computed by the server from the stored bytes (always present once an upload is `stored`).
    sha256: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      required() {
        return this.status === 'stored';
      },
    },
    durationSeconds: { type: Number, default: null, min: 0 },

    status: { type: String, enum: UPLOAD_STATUSES, default: 'stored', required: true },
    // How the bytes arrived: through the API (multipart stream) or directly from the browser.
    method: { type: String, enum: ['proxy', 'direct'], default: 'proxy' },
    // Direct uploads: which policy validates the file, verification bookkeeping, and the completion
    // result so that repeating a completion returns the same answer instead of a second source.
    kind: { type: String, enum: ['video', 'document', null], default: null },
    verifyingAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    outcome: { type: String, enum: ['created', 'requeued', 'existing', null], default: null },
    rejection: { type: String, maxlength: 60, default: null },
    expiresAt: { type: Date, required: true },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.user;
        delete ret.storageKey;
        delete ret.uploadKey;
        delete ret.sha256;
        if (ret.source) ret.source = ret.source.toString();
        return ret;
      },
    },
  }
);

uploadSchema.index({ storageKey: 1 }, { unique: true });
// Sweep of browser-upload keys whose presigned URL can no longer be used.
uploadSchema.index({ uploadKeyPurgedAt: 1, uploadKeyPurgeAfter: 1 }, { partialFilterExpression: { uploadKey: { $type: 'string' } } });
// Cleanup job: stored uploads past their expiry.
uploadSchema.index({ status: 1, expiresAt: 1 });
// Per-user cap on direct uploads that were started but not completed.
uploadSchema.index({ user: 1, status: 1 });
uploadSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.Upload || mongoose.model('Upload', uploadSchema);
module.exports.UPLOAD_STATUSES = UPLOAD_STATUSES;
