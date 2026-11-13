'use strict';

const mongoose = require('mongoose');
const { generationFields, baseTransform } = require('./shared');
const { SUMMARY_STYLES } = require('../queues/constants');

/**
 * The summary of a source rewritten in another style (concise, academic, ...).
 * Generated from the stored content, so the source is never re-fetched,
 * re-transcribed or re-extracted. One per source and style.
 */
const summaryVariantSchema = new mongoose.Schema(
  {
    ...generationFields(),
    style: { type: String, enum: SUMMARY_STYLES, required: true },
    title: { type: String, default: null, maxlength: 300 },
    overview: { type: String, default: null, maxlength: 3000 },
    sections: {
      type: [
        new mongoose.Schema(
          {
            heading: { type: String, required: true, maxlength: 200 },
            content: { type: String, required: true, maxlength: 8000 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    keyPoints: { type: [String], default: [] },
  },
  { timestamps: true, toJSON: { versionKey: false, transform: baseTransform } }
);

summaryVariantSchema.index({ source: 1, style: 1 }, { unique: true });

module.exports = mongoose.models.SummaryVariant || mongoose.model('SummaryVariant', summaryVariantSchema);
