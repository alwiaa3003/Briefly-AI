'use strict';

const mongoose = require('mongoose');
const { SUMMARY_STYLES, QUIZ_DIFFICULTIES, QUESTION_TYPES } = require('../queues/constants');

/** Per-user defaults for summary styles and study tools. */
const userPreferenceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    summaryStyle: { type: String, enum: ['standard', ...SUMMARY_STYLES], default: 'standard' },
    quizDifficulty: { type: String, enum: QUIZ_DIFFICULTIES, default: 'medium' },
    quizQuestionCount: { type: Number, min: 3, max: 30, default: 10 },
    quizQuestionTypes: { type: [{ type: String, enum: QUESTION_TYPES }], default: () => [...QUESTION_TYPES] },
    flashcardCount: { type: Number, min: 5, max: 60, default: 20 },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        delete ret._id;
        delete ret.user;
        delete ret.createdAt;
        return ret;
      },
    },
  }
);

userPreferenceSchema.index({ user: 1 }, { unique: true });

module.exports = mongoose.models.UserPreference || mongoose.model('UserPreference', userPreferenceSchema);
