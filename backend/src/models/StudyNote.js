'use strict';

const mongoose = require('mongoose');
const { refSchema, generationFields, baseTransform } = require('./shared');

const termSchema = new mongoose.Schema(
  {
    term: { type: String, required: true, maxlength: 200 },
    explanation: { type: String, required: true, maxlength: 1500 },
    refs: { type: [refSchema], default: [] },
  },
  { _id: false }
);

const itemSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, maxlength: 1200 },
    refs: { type: [refSchema], default: [] },
  },
  { _id: false }
);

/** Structured study notes for a source (one per source; regenerating replaces them). */
const studyNoteSchema = new mongoose.Schema(
  {
    ...generationFields(),
    title: { type: String, default: null, maxlength: 300 },
    overview: { type: String, default: null, maxlength: 3000 },
    keyConcepts: { type: [termSchema], default: [] },
    definitions: { type: [termSchema], default: [] },
    keyFacts: { type: [itemSchema], default: [] },
    examples: { type: [itemSchema], default: [] },
    formulas: { type: [itemSchema], default: [] },
    revisionPoints: { type: [itemSchema], default: [] },
    // General background added by the model that is NOT in the source. Shown separately, labelled.
    externalKnowledge: { type: [String], default: [] },
  },
  { timestamps: true, toJSON: { versionKey: false, transform: baseTransform } }
);

studyNoteSchema.index({ source: 1 }, { unique: true });
studyNoteSchema.index({ user: 1, updatedAt: -1 });

module.exports = mongoose.models.StudyNote || mongoose.model('StudyNote', studyNoteSchema);
