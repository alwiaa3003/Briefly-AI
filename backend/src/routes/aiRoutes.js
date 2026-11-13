'use strict';

/**
 * Milestone 5 endpoints: Ask AI conversations, smart search, retrieval index
 * status, study tools and preferences. Every route requires authentication and
 * every query is scoped to the signed-in user in the service layer.
 */

const express = require('express');
const { z } = require('zod');
const c = require('../controllers/aiController');
const { requireAuth } = require('../middleware/auth');
const { chatLimiter, studyLimiter, searchLimiter } = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const v = require('../validators/aiValidators');
const config = require('../config/env');
const { asyncHandler } = require('../utils/http');

const h = asyncHandler;
const withId = validate({ params: v.idParams });
const regenerate = validate({ params: v.idParams, body: v.regenerateSchema });

/* ------------------------------ /conversations ------------------------------ */
const conversations = express.Router();
conversations.use(requireAuth);
conversations.get('/', validate({ query: v.listConversationsQuerySchema }), h(c.listConversations));
conversations.post('/', validate({ body: v.createConversationSchema }), h(c.createConversation));
conversations.get('/:id', withId, h(c.getConversation));
conversations.patch('/:id', validate({ params: v.idParams, body: v.renameConversationSchema }), h(c.renameConversation));
conversations.delete('/:id', withId, h(c.deleteConversation));
conversations.post(
  '/:id/messages',
  chatLimiter,
  validate({ params: v.idParams, body: v.sendMessageSchema(config.rag.chatMaxMessageChars) }),
  h(c.sendMessage)
);

/* --------------------------------- /search --------------------------------- */
const search = express.Router();
search.use(requireAuth);
search.get('/', searchLimiter, validate({ query: v.searchQuerySchema }), h(c.search));

/* -------------------------- /sources/:id/... (study) -------------------------- */
const sourceStudy = express.Router();
sourceStudy.use(requireAuth);
sourceStudy.get('/:id/index', withId, h(c.getIndexStatus));
sourceStudy.post('/:id/index', studyLimiter, withId, h(c.reindexSource));
sourceStudy.get('/:id/notes', withId, h(c.getNotes));
sourceStudy.post('/:id/notes', studyLimiter, regenerate, h(c.generateNotes));
sourceStudy.get('/:id/flashcards', withId, h(c.getFlashcards));
sourceStudy.post(
  '/:id/flashcards',
  studyLimiter,
  validate({ params: v.idParams, body: v.flashcardRequestSchema.merge(v.regenerateSchema) }),
  h(c.generateFlashcards)
);
sourceStudy.get('/:id/quizzes', withId, h(c.listQuizzes));
sourceStudy.post('/:id/quizzes', studyLimiter, validate({ params: v.idParams, body: v.quizRequestSchema }), h(c.createQuiz));
sourceStudy.get('/:id/summary-styles', withId, h(c.listStyles));
sourceStudy.get('/:id/summary-styles/:style', validate({ params: v.styleParams }), h(c.getStyle));
sourceStudy.post(
  '/:id/summary-styles/:style',
  studyLimiter,
  validate({ params: v.styleParams, body: v.regenerateSchema }),
  h(c.generateStyle)
);

/* ---------------------------------- /quizzes ---------------------------------- */
const quizzes = express.Router();
quizzes.use(requireAuth);
quizzes.get('/:id', withId, h(c.getQuiz));
quizzes.delete('/:id', withId, h(c.deleteQuiz));
quizzes.get('/:id/attempts', withId, h(c.listAttempts));
quizzes.post('/:id/attempts', validate({ params: v.idParams, body: v.attemptSchema }), h(c.submitAttempt));
quizzes.get(
  '/:id/attempts/:attemptId',
  validate({ params: z.object({ id: v.objectId, attemptId: v.objectId }) }),
  h(c.getAttempt)
);

/* -------------------------------- /flashcards -------------------------------- */
const flashcards = express.Router();
flashcards.use(requireAuth);
flashcards.post(
  '/:id/cards/:cardId/review',
  validate({ params: v.cardReviewParams, body: v.cardReviewSchema }),
  h(c.reviewCard)
);
flashcards.post('/:id/reset', withId, h(c.resetDeck));

/* -------------------------------- /preferences -------------------------------- */
const preferences = express.Router();
preferences.use(requireAuth);
preferences.get('/', h(c.getPreferences));
preferences.put('/', validate({ body: v.preferencesSchema }), h(c.updatePreferences));

/* ---------------------------------- /usage ---------------------------------- */
const usage = express.Router();
usage.use(requireAuth);
usage.get('/', h(c.getUsage));

module.exports = { conversations, search, sourceStudy, quizzes, flashcards, preferences, usage };
