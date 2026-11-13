'use strict';

const mongoose = require('mongoose');

/** AI-generated summary of a Source. Exactly one per source. */
const summarySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },

    title: { type: String, required: true, maxlength: 300 },
    overview: { type: String, required: true, maxlength: 1500 },
    sections: {
      type: [
        new mongoose.Schema(
          {
            heading: { type: String, required: true, maxlength: 150 },
            content: { type: String, required: true, maxlength: 6000 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    keyTakeaways: { type: [String], default: [] },
    concepts: {
      type: [
        new mongoose.Schema(
          {
            term: { type: String, required: true, maxlength: 120 },
            explanation: { type: String, required: true, maxlength: 600 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    mainArguments: { type: [String], default: [] },

    // Videos only. Every time here was validated against a real transcript
    // segment start by the processing service (never model estimates).
    chapters: {
      type: [
        new mongoose.Schema(
          {
            title: { type: String, required: true, maxlength: 150 },
            startSeconds: { type: Number, required: true, min: 0 },
            endSeconds: { type: Number, default: null, min: 0 },
            summary: { type: String, required: true, maxlength: 1500 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    // Documents only. Page numbers / sections were validated against the
    // extracted text by the processing service (never invented).
    sectionBreakdown: {
      type: [
        new mongoose.Schema(
          {
            title: { type: String, required: true, maxlength: 200 },
            summary: { type: String, required: true, maxlength: 3000 },
            pages: { type: [Number], default: [] },
            section: { type: String, default: null, maxlength: 300 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    facts: {
      type: [
        new mongoose.Schema(
          {
            statement: { type: String, required: true, maxlength: 800 },
            pages: { type: [Number], default: [] },
            section: { type: String, default: null, maxlength: 300 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    // References for keyTakeaways / mainArguments / concepts, index-aligned with those arrays.
    references: {
      keyTakeaways: { type: [new mongoose.Schema({ pages: [Number], section: String }, { _id: false })], default: undefined },
      mainArguments: { type: [new mongoose.Schema({ pages: [Number], section: String }, { _id: false })], default: undefined },
      concepts: { type: [new mongoose.Schema({ pages: [Number], section: String }, { _id: false })], default: undefined },
    },
    keyMoments: {
      type: [
        new mongoose.Schema(
          {
            seconds: { type: Number, required: true, min: 0 },
            description: { type: String, required: true, maxlength: 300 },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // Provenance, for quality tracking and future re-generation.
    model: { type: String, required: true, maxlength: 100 },
    promptVersion: { type: String, required: true, maxlength: 50 },
    // Summary cache key (services/ai/summaryCache.js): same input = summary reused, no AI call.
    inputHash: { type: String, default: null, maxlength: 64 },
    inputTruncated: { type: Boolean, default: false },
    inputCharacters: { type: Number, default: null },
    usage: {
      inputTokens: { type: Number, default: null },
      outputTokens: { type: Number, default: null },
    },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.user;
        if (ret.source && typeof ret.source === 'object' && ret.source.toString) ret.source = ret.source.toString();
        return ret;
      },
    },
  }
);

summarySchema.index({ source: 1 }, { unique: true });
summarySchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.Summary || mongoose.model('Summary', summarySchema);
