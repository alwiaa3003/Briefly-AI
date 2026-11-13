'use strict';

const mongoose = require('mongoose');
const { SOURCE_KINDS, SOURCE_STATUSES, RAG_STATUSES } = require('../queues/constants');

/**
 * Something a user asked Briefly to summarize. In Milestone 2 that is always
 * an article URL; videos and documents will reuse this model with other kinds.
 *
 * The extracted text is stored once here (never in jobs or Redis) and is
 * excluded from queries unless explicitly selected.
 */
const sourceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: Object.values(SOURCE_KINDS), required: true },

    // Required for URL-based kinds (article, youtube); null for uploads (video, document).
    submittedUrl: {
      type: String,
      default: null,
      maxlength: 2048,
      required() {
        return this.kind !== SOURCE_KINDS.VIDEO && this.kind !== SOURCE_KINDS.DOCUMENT;
      },
    },
    // Duplicate-detection key, unique per user:
    //   articles  -> normalized URL (lowercase host, no fragment/tracking params)
    //   youtube   -> "youtube:<videoId>"
    //   uploads   -> "upload:<sha256 of the file>"
    normalizedUrl: { type: String, required: true, maxlength: 2048 },
    finalUrl: { type: String, default: null, maxlength: 2048 },
    canonicalUrl: { type: String, default: null, maxlength: 2048 },

    metadata: {
      title: { type: String, default: null, maxlength: 300 },
      author: { type: String, default: null, maxlength: 300 },
      publishedAt: { type: String, default: null, maxlength: 40 },
      siteName: { type: String, default: null, maxlength: 200 },
      description: { type: String, default: null, maxlength: 1000 },
      language: { type: String, default: null, maxlength: 35 },
      wordCount: { type: Number, default: null, min: 0 },
    },

    content: { type: String, default: null, select: false },
    contentTruncated: { type: Boolean, default: false },
    extractedAt: { type: Date, default: null },

    // Video-specific metadata (youtube and uploaded videos).
    video: {
      type: new mongoose.Schema(
        {
          platform: { type: String, enum: ['youtube', 'upload'], required: true },
          videoId: { type: String, default: null, maxlength: 20 },
          channelTitle: { type: String, default: null, maxlength: 200 },
          channelUrl: { type: String, default: null, maxlength: 2048 },
          thumbnailUrl: { type: String, default: null, maxlength: 2048 },
          durationSeconds: { type: Number, default: null, min: 0 },
          publishedAt: { type: String, default: null, maxlength: 40 },
          // What YouTube reports about caption tracks. Briefly does not use them as the
          // transcript source (see docs/ARCHITECTURE.md); this is informational only.
          captions: {
            available: { type: Boolean, default: null },
            manualLanguages: { type: [String], default: [] },
            autoLanguages: { type: [String], default: [] },
          },
          metadataSource: { type: String, default: null, maxlength: 40 },
          metadataFetchedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    upload: { type: mongoose.Schema.Types.ObjectId, ref: 'Upload', default: null },
    transcript: { type: mongoose.Schema.Types.ObjectId, ref: 'Transcript', default: null },
    // Fine-grained progress for long stages (e.g. transcription window 3 of 8, OCR page 4 of 12).
    progress: {
      type: new mongoose.Schema({ current: Number, total: Number, stage: String }, { _id: false }),
      default: null,
    },

    // Document-specific metadata (PDF / DOCX / TXT). Extracted text lives in DocumentPart.
    document: {
      type: new mongoose.Schema(
        {
          format: { type: String, enum: ['pdf', 'docx', 'txt'], required: true },
          pageCount: { type: Number, default: null, min: 0 },
          pagesProcessed: { type: Number, default: null, min: 0 },
          partCount: { type: Number, default: 0, min: 0 },
          wordCount: { type: Number, default: 0, min: 0 },
          charCount: { type: Number, default: 0, min: 0 },
          author: { type: String, default: null, maxlength: 300 },
          subject: { type: String, default: null, maxlength: 300 },
          created: { type: String, default: null, maxlength: 40 },
          modified: { type: String, default: null, maxlength: 40 },
          encoding: { type: String, default: null, maxlength: 40 },
          // Pages recognized with OCR, and scanned pages skipped because of DOCUMENT_MAX_OCR_PAGES.
          ocrPages: { type: [Number], default: [] },
          ocrSkippedPages: { type: [Number], default: [] },
          truncated: { type: Boolean, default: false },
          warnings: { type: [String], default: [] },
          strategy: { type: String, enum: ['direct', 'combine', null], default: null },
          extractedAt: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },

    status: {
      type: String,
      enum: Object.values(SOURCE_STATUSES),
      default: SOURCE_STATUSES.QUEUED,
      required: true,
    },
    error: {
      type: new mongoose.Schema({ code: String, message: String }, { _id: false }),
      default: null,
    },

    summary: { type: mongoose.Schema.Types.ObjectId, ref: 'Summary', default: null },

    // Retrieval index (ContentChunk documents with embeddings) used by Ask AI and smart search.
    rag: {
      type: new mongoose.Schema(
        {
          status: { type: String, enum: Object.values(RAG_STATUSES), default: RAG_STATUSES.NONE },
          chunkCount: { type: Number, default: 0, min: 0 },
          embeddedCount: { type: Number, default: 0, min: 0 },
          model: { type: String, default: null, maxlength: 100 },
          dimensions: { type: Number, default: null },
          // Hash of the chunked content; unchanged content is never re-embedded.
          contentHash: { type: String, default: null, maxlength: 64 },
          indexedAt: { type: Date, default: null },
          job: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcessingJob', default: null },
          error: { type: new mongoose.Schema({ code: String, message: String }, { _id: false }), default: null },
        },
        { _id: false }
      ),
      default: () => ({ status: RAG_STATUSES.NONE }),
    },
    latestJob: { type: mongoose.Schema.Types.ObjectId, ref: 'ProcessingJob', default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.user;
        delete ret.content;
        delete ret.normalizedUrl;
        if (ret.rag) delete ret.rag.job;
        return ret;
      },
    },
  }
);

// Library listing (newest first) and status filtering per user.
sourceSchema.index({ user: 1, createdAt: -1 });
sourceSchema.index({ user: 1, status: 1, createdAt: -1 });
// One source per URL per user: duplicate submissions reuse the existing record.
sourceSchema.index({ user: 1, normalizedUrl: 1 }, { unique: true });

module.exports = mongoose.models.Source || mongoose.model('Source', sourceSchema);
