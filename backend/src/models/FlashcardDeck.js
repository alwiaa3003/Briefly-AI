'use strict';

const mongoose = require('mongoose');
const { refSchema, generationFields, baseTransform } = require('./shared');

const cardSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, maxlength: 20 },
    front: { type: String, required: true, maxlength: 600 },
    back: { type: String, required: true, maxlength: 1500 },
    refs: { type: [refSchema], default: [] },
    // Basic review tracking: new -> learning / known.
    review: {
      status: { type: String, enum: ['new', 'learning', 'known'], default: 'new' },
      reviews: { type: Number, default: 0 },
      lastReviewedAt: { type: Date, default: null },
    },
  },
  { _id: false }
);

/** Flashcards for a source (one deck per source; regenerating replaces the cards). */
const flashcardDeckSchema = new mongoose.Schema(
  {
    ...generationFields(),
    requestedCount: { type: Number, default: 20 },
    cards: { type: [cardSchema], default: [] },
  },
  { timestamps: true, toJSON: { versionKey: false, transform: baseTransform } }
);

flashcardDeckSchema.index({ source: 1 }, { unique: true });
flashcardDeckSchema.index({ user: 1, updatedAt: -1 });

module.exports = mongoose.models.FlashcardDeck || mongoose.model('FlashcardDeck', flashcardDeckSchema);
