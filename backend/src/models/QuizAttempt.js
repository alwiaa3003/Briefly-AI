'use strict';

const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema(
  {
    questionId: { type: String, required: true, maxlength: 20 },
    // The user's answer: option index, boolean, or short text.
    response: { type: mongoose.Schema.Types.Mixed, default: null },
    correct: { type: Boolean, required: true },
  },
  { _id: false }
);

/** One submitted, server-scored attempt at a quiz. */
const quizAttemptSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    quiz: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true },
    source: { type: mongoose.Schema.Types.ObjectId, ref: 'Source', required: true },
    answers: { type: [answerSchema], default: [] },
    score: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 1 },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform(_doc, ret) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.user;
        ret.quiz = ret.quiz?.toString();
        ret.source = ret.source?.toString();
        return ret;
      },
    },
  }
);

quizAttemptSchema.index({ quiz: 1, createdAt: -1 });
quizAttemptSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.models.QuizAttempt || mongoose.model('QuizAttempt', quizAttemptSchema);
