import { apiClient } from './apiClient';

/*
 * Ask AI, smart search, study tools, preferences and AI usage.
 * All AI work happens server-side; the browser never sees credentials.
 */

const enc = encodeURIComponent;
const data = (response) => response.data.data;

/* ------------------------------ Conversations ------------------------------ */

export async function listConversations({ sourceId, scope, page, limit } = {}) {
  const params = {};
  if (sourceId) params.sourceId = sourceId;
  if (scope) params.scope = scope;
  if (page) params.page = page;
  if (limit) params.limit = limit;
  return data(await apiClient.get('/conversations', { params }));
}

export async function createConversation({ scope, sourceId }) {
  return data(await apiClient.post('/conversations', { scope, ...(sourceId && { sourceId }) })).conversation;
}

export async function getConversation(id) {
  return data(await apiClient.get(`/conversations/${enc(id)}`));
}

export async function renameConversation(id, title) {
  return data(await apiClient.patch(`/conversations/${enc(id)}`, { title })).conversation;
}

export async function deleteConversation(id) {
  await apiClient.delete(`/conversations/${enc(id)}`);
}

/**
 * Answers take a few seconds; the default client timeout is extended. `clientRequestId` makes
 * re-sending the same question (double click, network retry) return the stored answer.
 */
export async function sendMessage(id, content, clientRequestId) {
  return data(
    await apiClient.post(
      `/conversations/${enc(id)}/messages`,
      { content, ...(clientRequestId && { clientRequestId }) },
      { timeout: 120000 }
    )
  );
}

export function newRequestId() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return random.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

/* --------------------------------- Search --------------------------------- */

export async function searchLibrary({ q, kind, from, to, limit } = {}) {
  const params = { q };
  if (kind) params.kind = kind;
  if (from) params.from = from;
  if (to) params.to = to;
  if (limit) params.limit = limit;
  return data(await apiClient.get('/search', { params }));
}

/* ------------------------------ Study tools ------------------------------ */

export async function getIndexStatus(sourceId) {
  return data(await apiClient.get(`/sources/${enc(sourceId)}/index`)).rag;
}

export async function reindexSource(sourceId) {
  return data(await apiClient.post(`/sources/${enc(sourceId)}/index`));
}

export async function getNotes(sourceId) {
  return data(await apiClient.get(`/sources/${enc(sourceId)}/notes`)).item;
}

export async function generateNotes(sourceId, { regenerate = false } = {}) {
  return data(await apiClient.post(`/sources/${enc(sourceId)}/notes`, { regenerate })).item;
}

export async function getFlashcards(sourceId) {
  return data(await apiClient.get(`/sources/${enc(sourceId)}/flashcards`)).item;
}

export async function generateFlashcards(sourceId, { count, regenerate = false } = {}) {
  return data(await apiClient.post(`/sources/${enc(sourceId)}/flashcards`, { ...(count && { count }), regenerate })).item;
}

export async function reviewFlashcard(deckId, cardId, status) {
  return data(await apiClient.post(`/flashcards/${enc(deckId)}/cards/${enc(cardId)}/review`, { status })).item;
}

export async function resetFlashcards(deckId) {
  return data(await apiClient.post(`/flashcards/${enc(deckId)}/reset`)).item;
}

export async function listQuizzes(sourceId) {
  return data(await apiClient.get(`/sources/${enc(sourceId)}/quizzes`)).items;
}

/** Resolves with { item, reused, queued }: identical settings reuse an existing quiz unless `regenerate`. */
export async function createQuiz(sourceId, options = {}) {
  return data(await apiClient.post(`/sources/${enc(sourceId)}/quizzes`, options));
}

export async function getQuiz(quizId) {
  return data(await apiClient.get(`/quizzes/${enc(quizId)}`)).item;
}

export async function deleteQuiz(quizId) {
  await apiClient.delete(`/quizzes/${enc(quizId)}`);
}

/** Resolves with { attempt, questions } — the full review, available only after submitting. */
export async function submitQuiz(quizId, answers) {
  return data(await apiClient.post(`/quizzes/${enc(quizId)}/attempts`, { answers }));
}

export async function getSummaryStyle(sourceId, style) {
  return data(await apiClient.get(`/sources/${enc(sourceId)}/summary-styles/${enc(style)}`)).item;
}

export async function generateSummaryStyle(sourceId, style, { regenerate = false } = {}) {
  return data(await apiClient.post(`/sources/${enc(sourceId)}/summary-styles/${enc(style)}`, { regenerate })).item;
}

/* ---------------------------------- Usage ---------------------------------- */

/** GET /api/usage — Briefly's AI budgets, today's usage and Gemini availability. */
export async function getUsage() {
  return data(await apiClient.get('/usage')).usage;
}

/* ------------------------------- Preferences ------------------------------- */

export async function getPreferences() {
  return data(await apiClient.get('/preferences')).preferences;
}

export async function updatePreferences(changes) {
  return data(await apiClient.put('/preferences', changes)).preferences;
}
