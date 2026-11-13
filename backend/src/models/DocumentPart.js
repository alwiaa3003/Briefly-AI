'use strict';

const mongoose = require('mongoose');

/**
 * Extracted content of one part of a document: a page for PDFs, or a
 * heading-aligned group of blocks (about DOCUMENT_PART_CHARS) for DOCX/TXT.
 *
 * Storing parts separately keeps every MongoDB document small (a few KB to tens
 * of KB) regardless of document length, keeps page references attached to
 * their text, and lets OCR results be saved page by page (resumable).
 */
const blockSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['heading', 'paragraph', 'list', 'table'], required: true },
    level: { type: Number, default: null, min: 1, max: 6 },
    text: { type: String, required: true, maxlength: 60000 },
  },
  { _id: false }
);

const documentPartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },
    index: { type: Number, required: true, min: 0 },
    page: { type: Number, default: null, min: 1 },
    headingPath: { type: [String], default: [] },
    blocks: { type: [blockSchema], default: [] },
    needsOcr: { type: Boolean, default: false },
    ocrDone: { type: Boolean, default: false },
    charCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        delete ret._id;
        delete ret.user;
        delete ret.source;
        return ret;
      },
    },
  }
);

documentPartSchema.index({ source: 1, index: 1 }, { unique: true });
documentPartSchema.index({ source: 1, needsOcr: 1, ocrDone: 1 });

module.exports = mongoose.models.DocumentPart || mongoose.model('DocumentPart', documentPartSchema);
