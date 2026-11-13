'use strict';

const chatService = require('../services/chatService');
const searchService = require('../services/searchService');
const studyService = require('../services/studyService');
const preferenceService = require('../services/preferenceService');
const aiGate = require('../services/ai/aiGate');
const { scheduleIndexing } = require('../services/rag/indexService');
const Source = require('../models/Source');
const ApiError = require('../utils/ApiError');
const { sendSuccess } = require('../utils/http');

const uid = (req) => req.auth.userId;
const json = (doc) => (doc ? doc.toJSON() : null);

/** Adds `stale: true` when the source content changed after the item was generated. */
async function withStale(req, doc) {
  if (!doc) return null;
  const source = await Source.findOne({ _id: doc.source, user: uid(req) }).select('rag.contentHash').lean();
  return { ...doc.toJSON(), stale: studyService.isStale(doc, source) };
}

/* ------------------------------ Conversations ------------------------------ */

async function createConversation(req, res) {
  sendSuccess(res, 201, { conversation: await chatService.createConversation({ userId: uid(req), ...req.body }) });
}

async function listConversations(req, res) {
  sendSuccess(res, 200, await chatService.listConversations({ userId: uid(req), ...req.query }));
}

async function getConversation(req, res) {
  sendSuccess(res, 200, await chatService.getConversation({ userId: uid(req), conversationId: req.params.id }));
}

async function renameConversation(req, res) {
  const conversation = await chatService.renameConversation({ userId: uid(req), conversationId: req.params.id, title: req.body.title });
  sendSuccess(res, 200, { conversation });
}

async function deleteConversation(req, res) {
  await chatService.deleteConversation({ userId: uid(req), conversationId: req.params.id });
  sendSuccess(res, 200, { deleted: true });
}

async function sendMessage(req, res) {
  const result = await chatService.sendMessage({
    userId: uid(req),
    conversationId: req.params.id,
    content: req.body.content,
    clientRequestId: req.body.clientRequestId,
  });
  sendSuccess(res, result.duplicate ? 200 : 201, result);
}

/* ---------------------------------- Search --------------------------------- */

async function search(req, res) {
  sendSuccess(res, 200, await searchService.search({ userId: uid(req), ...req.query }));
}

/* ------------------------------ Index (RAG) ------------------------------ */

async function getIndexStatus(req, res) {
  const source = await Source.findOne({ _id: req.params.id, user: uid(req) }).select('rag');
  if (!source) throw ApiError.notFound('Source not found.', 'SOURCE_NOT_FOUND');
  sendSuccess(res, 200, { rag: source.toJSON().rag });
}

async function reindexSource(req, res) {
  const source = await Source.findOne({ _id: req.params.id, user: uid(req) }).select('status');
  if (!source) throw ApiError.notFound('Source not found.', 'SOURCE_NOT_FOUND');
  if (source.status !== 'completed') throw ApiError.conflict('Only completed sources can be indexed.', 'SOURCE_NOT_READY');
  const job = await scheduleIndexing({ sourceId: source._id, userId: uid(req) });
  const updated = await Source.findById(source._id).select('rag');
  sendSuccess(res, job ? 202 : 200, { rag: updated.toJSON().rag, queued: Boolean(job) });
}

/* ---------------------------------- Study ---------------------------------- */

const generated = (res, { item, queued, cached }) =>
  sendSuccess(res, queued ? 202 : 200, { item: json(item), queued, cached: Boolean(cached) });

async function getNotes(req, res) {
  sendSuccess(res, 200, { item: await withStale(req, await studyService.getNotes({ userId: uid(req), sourceId: req.params.id })) });
}
async function generateNotes(req, res) {
  generated(res, await studyService.generateNotes({ userId: uid(req), sourceId: req.params.id, regenerate: req.body.regenerate }));
}

async function getFlashcards(req, res) {
  sendSuccess(res, 200, { item: await withStale(req, await studyService.getFlashcards({ userId: uid(req), sourceId: req.params.id })) });
}
async function generateFlashcards(req, res) {
  generated(
    res,
    await studyService.generateFlashcards({ userId: uid(req), sourceId: req.params.id, count: req.body.count, regenerate: req.body.regenerate })
  );
}
async function reviewCard(req, res) {
  const deck = await studyService.reviewCard({ userId: uid(req), deckId: req.params.id, cardId: req.params.cardId, status: req.body.status });
  sendSuccess(res, 200, { item: deck.toJSON() });
}
async function resetDeck(req, res) {
  sendSuccess(res, 200, { item: (await studyService.resetDeckProgress({ userId: uid(req), deckId: req.params.id })).toJSON() });
}

async function listStyles(req, res) {
  const items = await studyService.listStyles({ userId: uid(req), sourceId: req.params.id });
  sendSuccess(res, 200, { items: items.map((i) => i.toJSON()) });
}
async function getStyle(req, res) {
  sendSuccess(res, 200, {
    item: await withStale(req, await studyService.getStyle({ userId: uid(req), sourceId: req.params.id, style: req.params.style })),
  });
}
async function generateStyle(req, res) {
  generated(
    res,
    await studyService.generateStyle({ userId: uid(req), sourceId: req.params.id, style: req.params.style, regenerate: req.body.regenerate })
  );
}

async function listQuizzes(req, res) {
  const items = await studyService.listQuizzes({ userId: uid(req), sourceId: req.params.id });
  sendSuccess(res, 200, { items: items.map((i) => i.toJSON()) });
}
async function createQuiz(req, res) {
  const { item, reused, queued } = await studyService.createQuiz({ userId: uid(req), sourceId: req.params.id, ...req.body });
  sendSuccess(res, queued ? 202 : 200, { item: item.toJSON(), queued, reused });
}
async function getQuiz(req, res) {
  sendSuccess(res, 200, { item: (await studyService.getQuiz({ userId: uid(req), quizId: req.params.id })).toJSON() });
}
async function deleteQuiz(req, res) {
  await studyService.deleteQuiz({ userId: uid(req), quizId: req.params.id });
  sendSuccess(res, 200, { deleted: true });
}
async function submitAttempt(req, res) {
  sendSuccess(res, 201, await studyService.submitAttempt({ userId: uid(req), quizId: req.params.id, answers: req.body.answers }));
}
async function listAttempts(req, res) {
  sendSuccess(res, 200, { items: await studyService.listAttempts({ userId: uid(req), quizId: req.params.id }) });
}
async function getAttempt(req, res) {
  sendSuccess(res, 200, await studyService.getAttempt({ userId: uid(req), quizId: req.params.id, attemptId: req.params.attemptId }));
}

/* ---------------------------------- Usage ---------------------------------- */

/** GET /api/usage — Briefly's AI budgets and usage today, and Gemini availability (no secrets). */
async function getUsage(req, res) {
  res.set('Cache-Control', 'no-store');
  sendSuccess(res, 200, { usage: await aiGate.getUsageOverview(uid(req)) });
}

/* ------------------------------- Preferences ------------------------------- */

async function getPreferences(req, res) {
  sendSuccess(res, 200, { preferences: await preferenceService.getPreferences({ userId: uid(req) }) });
}
async function updatePreferences(req, res) {
  sendSuccess(res, 200, { preferences: await preferenceService.updatePreferences({ userId: uid(req), changes: req.body }) });
}

module.exports = {
  createConversation,
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
  sendMessage,
  search,
  getIndexStatus,
  reindexSource,
  getNotes,
  generateNotes,
  getFlashcards,
  generateFlashcards,
  reviewCard,
  resetDeck,
  listStyles,
  getStyle,
  generateStyle,
  listQuizzes,
  createQuiz,
  getQuiz,
  deleteQuiz,
  submitAttempt,
  listAttempts,
  getAttempt,
  getPreferences,
  updatePreferences,
  getUsage,
};
