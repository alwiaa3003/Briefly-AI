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
 */
const uploadSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', default: null },

    // Random, server-generated key. User input never becomes part of a storage path.
    storageKey: { type: String, required: true, maxlength: 300 },
    // Display only (sanitized); never used to build paths.
    originalName: { type: String, required: true, maxlength: 200 },
    mimeType: { type: String, required: true, maxlength: 100 },
    // Detected format: video containers or document formats.
    container: { type: String, enum: ['mp4', 'mov', 'webm', 'mkv', 'pdf', 'docx', 'txt'], required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    durationSeconds: { type: Number, default: null, min: 0 },

    status: { type: String, enum: ['stored', 'deleted'], default: 'stored', required: true },
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
        delete ret.sha256;
        if (ret.source) ret.source = ret.source.toString();
        return ret;
      },
    },
  }
);

uploadSchema.index({ storageKey: 1 }, { unique: true });
// Cleanup job: stored uploads past their expiry.
uploadSchema.index({ status: 1, expiresAt: 1 });
uploadSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.Upload || mongoose.model('Upload', uploadSchema);
