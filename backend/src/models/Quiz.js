'use strict';

const mongoose = require('mongoose');
const { refSchema, generationFields, baseTransform } = require('./shared');
const { QUIZ_DIFFICULTIES, QUESTION_TYPES } = require('../queues/constants');

const questionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, maxlength: 20 },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    question: { type: String, required: true, maxlength: 1000 },
    options: { type: [String], default: [] },
    // Answer key: never sent to the client before an attempt is submitted.
    correctOption: { type: Number, default: null },
    correctBoolean: { type: Boolean, default: null },
    acceptedAnswers: { type: [String], default: [] },
    explanation: { type: String, required: true, maxlength: 1500 },
    refs: { type: [refSchema], default: [] },
  },
  { _id: false }
);

/** A generated quiz. A source can have several (each generation creates a new quiz). */
const quizSchema = new mongoose.Schema(
  {
    ...generationFields(),
    title: { type: String, default: null, maxlength: 300 },
    difficulty: { type: String, enum: QUIZ_DIFFICULTIES, required: true },
    requestedCount: { type: Number, required: true, min: 1, max: 30 },
    types: { type: [{ type: String, enum: QUESTION_TYPES }], default: [] },
    questions: { type: [questionSchema], default: [] },
    attemptCount: { type: Number, default: 0 },
    bestScore: { type: Number, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(doc, ret) {
        baseTransform(doc, ret);
        // Answers stay server-side; see quizService.toQuestionReview for post-submission review.
        ret.questions = (ret.questions || []).map(({ id, type, question, options }) => ({ id, type, question, options }));
        return ret;
      },
    },
  }
);

quizSchema.index({ user: 1, source: 1, createdAt: -1 });

module.exports = mongoose.models.Quiz || mongoose.model('Quiz', quizSchema);
