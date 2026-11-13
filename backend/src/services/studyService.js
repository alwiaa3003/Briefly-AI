'use strict';

/**
 * Study tools: notes, quizzes (with server-side scoring), flashcards (with
 * review tracking) and alternative summary styles. Generation runs as
 * background jobs (see workers/handlers/studyHandlers.js); these functions
 * create/claim the target document, queue the job and serve results.
 */

const Source = require('../models/Source');
const StudyNote = require('../models/StudyNote');
const Quiz = require('../models/Quiz');
const QuizAttempt = require('../models/QuizAttempt');
const FlashcardDeck = require('../models/FlashcardDeck');
const SummaryVariant = require('../models/SummaryVariant');
const jobService = require('./jobService');
const preferenceService = require('./preferenceService');
const { isQueueAvailable } = require('../queues/processingQueue');
const { JOB_TYPES, GENERATION_STATUSES, SOURCE_STATUSES } = require('../queues/constants');
const ApiError = require('../utils/ApiError');

const IN_PROGRESS = [GENERATION_STATUSES.QUEUED, GENERATION_STATUSES.GENERATING];

async function requireCompletedSource(userId, sourceId) {
  const source = await Source.findOne({ _id: sourceId, user: userId }).select('status rag.contentHash');
  if (!source) throw ApiError.notFound('Source not found.', 'SOURCE_NOT_FOUND');
  if (source.status !== SOURCE_STATUSES.COMPLETED) {
    throw ApiError.conflict('Study tools are available once the summary is ready.', 'SOURCE_NOT_READY');
  }
  return source;
}

function ensureQueue() {
  if (!isQueueAvailable()) throw ApiError.serviceUnavailable(jobService.QUEUE_UNAVAILABLE_MESSAGE, 'QUEUE_UNAVAILABLE');
}

async function queueGeneration(Model, doc, type, userId) {
  try {
    const job = await jobService.enqueueProcessingJob({
      userId,
      type,
      input: { targetId: String(doc._id), userId: String(userId) },
      sourceId: doc.source,
    });
    return Model.findOneAndUpdate({ _id: doc._id }, { $set: { job: job._id } }, { new: true });
  } catch (error) {
    await Model.updateOne(
      { _id: doc._id },
      { $set: { status: GENERATION_STATUSES.FAILED, error: { code: 'QUEUE_UNAVAILABLE', message: 'Generation could not be queued.' } } }
    );
    throw error;
  }
}

/**
 * Single-document tools (notes, flashcards, a summary style): reuse a completed
 * or in-progress document unless `regenerate`, otherwise (re)claim it as queued.
 */
/** The source changed since this item was generated (it will be regenerated on the next request). */
function isStale(item, source) {
  const current = source?.rag?.contentHash;
  return Boolean(item?.sourceContentHash && current && item.sourceContentHash !== current);
}

/**
 * Single-document tools (notes, flashcards, a summary style), cached per source:
 *   - in progress           -> returned as is (absorbs double clicks; no second job)
 *   - completed, unchanged  -> reused without any AI request, unless `regenerate`
 *   - completed, but the source content changed, failed, or regenerate -> queued again
 * `fieldsMatch` lets a different configuration (e.g. flashcard count) count as a change.
 */
async function generateSingleton({ Model, type, userId, sourceId, key = {}, fields = {}, regenerate = false }) {
  const source = await requireCompletedSource(userId, sourceId);
  const filter = { source: sourceId, user: userId, ...key };
  const existing = await Model.findOne(filter);
  if (existing && IN_PROGRESS.includes(existing.status)) return { item: existing, queued: false };
  const sameConfig = Object.entries(fields).every(([k, v]) => existing?.[k] === v);
  if (existing && existing.status === GENERATION_STATUSES.COMPLETED && !regenerate && sameConfig && !isStale(existing, source)) {
    return { item: existing, queued: false, cached: true };
  }

  ensureQueue();
  const doc = await Model.findOneAndUpdate(
    filter,
    { $set: { status: GENERATION_STATUSES.QUEUED, error: null, ...fields } },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  return { item: await queueGeneration(Model, doc, type, userId), queued: true };
}

/* --------------------------------- Notes --------------------------------- */

async function getNotes({ userId, sourceId }) {
  return StudyNote.findOne({ source: sourceId, user: userId });
}

function generateNotes({ userId, sourceId, regenerate }) {
  return generateSingleton({ Model: StudyNote, type: JOB_TYPES.GENERATE_STUDY_NOTES, userId, sourceId, regenerate });
}

/* ------------------------------- Flashcards ------------------------------- */

async function getFlashcards({ userId, sourceId }) {
  return FlashcardDeck.findOne({ source: sourceId, user: userId });
}

async function generateFlashcards({ userId, sourceId, count, regenerate }) {
  const prefs = await preferenceService.getPreferences({ userId });
  return generateSingleton({
    Model: FlashcardDeck,
    type: JOB_TYPES.GENERATE_FLASHCARDS,
    userId,
    sourceId,
    regenerate,
    fields: { requestedCount: count || prefs.flashcardCount },
  });
}

async function reviewCard({ userId, deckId, cardId, status }) {
  const deck = await FlashcardDeck.findOneAndUpdate(
    { _id: deckId, user: userId, 'cards.id': cardId },
    {
      $set: { 'cards.$.review.status': status, 'cards.$.review.lastReviewedAt': new Date() },
      $inc: { 'cards.$.review.reviews': 1 },
    },
    { new: true }
  );
  if (!deck) throw ApiError.notFound('Flashcard not found.', 'FLASHCARD_NOT_FOUND');
  return deck;
}

async function resetDeckProgress({ userId, deckId }) {
  const deck = await FlashcardDeck.findOneAndUpdate(
    { _id: deckId, user: userId },
    { $set: { 'cards.$[].review': { status: 'new', reviews: 0, lastReviewedAt: null } } },
    { new: true }
  );
  if (!deck) throw ApiError.notFound('Flashcards not found.', 'FLASHCARD_NOT_FOUND');
  return deck;
}

/* ----------------------------- Summary styles ----------------------------- */

function listStyles({ userId, sourceId }) {
  return SummaryVariant.find({ source: sourceId, user: userId }).sort({ style: 1 });
}

function getStyle({ userId, sourceId, style }) {
  return SummaryVariant.findOne({ source: sourceId, user: userId, style });
}

function generateStyle({ userId, sourceId, style, regenerate }) {
  return generateSingleton({
    Model: SummaryVariant,
    type: JOB_TYPES.GENERATE_SUMMARY_STYLE,
    userId,
    sourceId,
    key: { style },
    regenerate,
  });
}

/* --------------------------------- Quizzes --------------------------------- */

/**
 * Quizzes: a quiz with the same settings that is still being generated is returned instead
 * of starting another (double clicks), and a completed one for unchanged content is reused
 * unless `regenerate` asks for a fresh set of questions.
 */
async function createQuiz({ userId, sourceId, count, difficulty, types, regenerate = false }) {
  const source = await requireCompletedSource(userId, sourceId);
  const prefs = await preferenceService.getPreferences({ userId });
  const options = {
    requestedCount: count || prefs.quizQuestionCount,
    difficulty: difficulty || prefs.quizDifficulty,
    types: [...new Set(types?.length ? types : prefs.quizQuestionTypes)].sort(),
  };
  const sameSettings = { user: userId, source: sourceId, requestedCount: options.requestedCount, difficulty: options.difficulty, types: options.types };
  const inProgress = await Quiz.findOne({ ...sameSettings, status: { $in: IN_PROGRESS } }).sort({ createdAt: -1 });
  if (inProgress) return { item: inProgress, reused: true, queued: false };
  if (!regenerate) {
    const done = await Quiz.findOne({ ...sameSettings, status: GENERATION_STATUSES.COMPLETED }).sort({ createdAt: -1 });
    if (done && !isStale(done, source)) return { item: done, reused: true, queued: false };
  }
  ensureQueue();
  const quiz = await Quiz.create({ user: userId, source: sourceId, status: GENERATION_STATUSES.QUEUED, ...options });
  return { item: await queueGeneration(Quiz, quiz, JOB_TYPES.GENERATE_QUIZ, userId), reused: false, queued: true };
}

function listQuizzes({ userId, sourceId }) {
  return Quiz.find({ source: sourceId, user: userId }).sort({ createdAt: -1 }).limit(20);
}

async function getQuiz({ userId, quizId }) {
  const quiz = await Quiz.findOne({ _id: quizId, user: userId });
  if (!quiz) throw ApiError.notFound('Quiz not found.', 'QUIZ_NOT_FOUND');
  return quiz;
}

async function deleteQuiz({ userId, quizId }) {
  const quiz = await getQuiz({ userId, quizId });
  await QuizAttempt.deleteMany({ quiz: quiz._id, user: userId });
  await Quiz.deleteOne({ _id: quiz._id, user: userId });
}

const ARTICLES = new Set(['a', 'an', 'the']);
function normalizeAnswer(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !ARTICLES.has(w))
    .join(' ');
}

/**
 * Deterministic short-answer grading: correct when the answer equals an accepted
 * answer, contains it as whole words, or covers at least 80% of its words.
 */
function gradeShortAnswer(response, accepted) {
  const answer = normalizeAnswer(response);
  if (!answer) return false;
  const words = new Set(answer.split(' '));
  return accepted.some((candidate) => {
    const target = normalizeAnswer(candidate);
    if (!target) return false;
    if (answer === target || ` ${answer} `.includes(` ${target} `)) return true;
    const targetWords = target.split(' ');
    const covered = targetWords.filter((w) => words.has(w)).length;
    return targetWords.length >= 2 && covered / targetWords.length >= 0.8;
  });
}

function isCorrect(question, response) {
  if (question.type === 'multiple_choice') return Number.isInteger(response) && response === question.correctOption;
  if (question.type === 'true_false') return typeof response === 'boolean' && response === question.correctBoolean;
  return typeof response === 'string' && gradeShortAnswer(response, question.acceptedAnswers);
}

/** Full review of a question (answers + explanation). Only returned after an attempt. */
function toQuestionReview(question, answer) {
  return {
    id: question.id,
    type: question.type,
    question: question.question,
    options: question.options,
    correctOption: question.correctOption,
    correctBoolean: question.correctBoolean,
    acceptedAnswers: question.acceptedAnswers,
    explanation: question.explanation,
    refs: question.refs,
    response: answer ? answer.response : null,
    correct: answer ? answer.correct : false,
  };
}

function attemptReview(quiz, attempt) {
  const answers = new Map(attempt.answers.map((a) => [a.questionId, a]));
  return {
    attempt: attempt.toJSON(),
    questions: quiz.questions.map((q) => toQuestionReview(q, answers.get(q.id))),
  };
}

async function submitAttempt({ userId, quizId, answers }) {
  const quiz = await getQuiz({ userId, quizId });
  if (quiz.status !== GENERATION_STATUSES.COMPLETED || !quiz.questions.length) {
    throw ApiError.conflict('This quiz is not ready yet.', 'QUIZ_NOT_READY');
  }
  const graded = quiz.questions.map((q) => {
    const response = Object.prototype.hasOwnProperty.call(answers, q.id) ? answers[q.id] : null;
    return { questionId: q.id, response, correct: response !== null && isCorrect(q, response) };
  });
  const score = graded.filter((a) => a.correct).length;
  const attempt = await QuizAttempt.create({
    user: userId,
    quiz: quiz._id,
    source: quiz.source,
    answers: graded,
    score,
    total: quiz.questions.length,
  });
  await Quiz.updateOne(
    { _id: quiz._id },
    { $inc: { attemptCount: 1 }, $max: { bestScore: Math.round((score / quiz.questions.length) * 100) } }
  );
  return attemptReview(quiz, attempt);
}

async function listAttempts({ userId, quizId }) {
  const quiz = await getQuiz({ userId, quizId });
  const attempts = await QuizAttempt.find({ quiz: quiz._id, user: userId }).sort({ createdAt: -1 }).limit(20);
  return attempts.map((a) => ({ id: a.id, score: a.score, total: a.total, createdAt: a.createdAt }));
}

async function getAttempt({ userId, quizId, attemptId }) {
  const quiz = await getQuiz({ userId, quizId });
  const attempt = await QuizAttempt.findOne({ _id: attemptId, quiz: quiz._id, user: userId });
  if (!attempt) throw ApiError.notFound('Attempt not found.', 'ATTEMPT_NOT_FOUND');
  return attemptReview(quiz, attempt);
}

module.exports = {
  getNotes,
  generateNotes,
  getFlashcards,
  generateFlashcards,
  reviewCard,
  resetDeckProgress,
  listStyles,
  getStyle,
  generateStyle,
  createQuiz,
  listQuizzes,
  getQuiz,
  deleteQuiz,
  isStale,
  requireCompletedSource,
  submitAttempt,
  listAttempts,
  getAttempt,
  gradeShortAnswer,
  normalizeAnswer,
};
