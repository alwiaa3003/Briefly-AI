'use strict';

/**
 * Ask AI: persistent conversations about one source or the whole library.
 *
 * For every question: retrieve the most relevant chunks of the user's own
 * content (hybrid search, always filtered by owner and, for source chats, by
 * source), send only those plus a bounded history to the processing service,
 * and store the answer with citations resolved to real sources / pages /
 * timestamps. Whole documents are never sent.
 */

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Source = require('../models/Source');
const Summary = require('../models/Summary');
const ContentChunk = require('../models/ContentChunk');
const processingClient = require('./processingClient');
const { retrieve } = require('./rag/retrieval');
const { scheduleIndexing } = require('./rag/indexService');
const { answerResultSchema } = require('../validators/aiValidators');
const { toApiError } = require('./aiErrors');
const aiGate = require('./ai/aiGate');
const config = require('../config/env');
const { RAG_STATUSES, SOURCE_STATUSES } = require('../queues/constants');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const HISTORY_CHARS = 1500;

function titleOf(source, summary) {
  return source?.metadata?.title || summary?.title || 'Untitled';
}

async function findOwnedConversation(userId, conversationId) {
  const conversation = await Conversation.findOne({ _id: conversationId, user: userId });
  if (!conversation) throw ApiError.notFound('Conversation not found.', 'CONVERSATION_NOT_FOUND');
  return conversation;
}

async function sourceInfo(userId, sourceId) {
  if (!sourceId) return null;
  const source = await Source.findOne({ _id: sourceId, user: userId }).select('kind metadata status rag summary createdAt');
  if (!source) return null;
  const summary = source.summary ? await Summary.findOne({ _id: source.summary, user: userId }).select('title') : null;
  return { id: source.id, kind: source.kind, title: titleOf(source, summary), status: source.status, rag: source.rag };
}

async function toConversationJSON(conversation, userId) {
  const json = conversation.toJSON();
  json.source = conversation.source ? await sourceInfo(userId, conversation.source) : null;
  return json;
}

/* ------------------------------ Conversations ------------------------------ */

async function createConversation({ userId, scope, sourceId, title }) {
  if (scope === 'source') {
    const source = await Source.findOne({ _id: sourceId, user: userId }).select('status rag');
    if (!source) throw ApiError.notFound('Source not found.', 'SOURCE_NOT_FOUND');
    if (source.status !== SOURCE_STATUSES.COMPLETED) {
      throw ApiError.conflict('You can ask questions once the summary is ready.', 'SOURCE_NOT_READY');
    }
    // Older sources (summarized before Ask AI existed) are indexed on first use.
    if ([RAG_STATUSES.NONE, RAG_STATUSES.FAILED].includes(source.rag?.status || RAG_STATUSES.NONE)) {
      await scheduleIndexing({ sourceId, userId }).catch((error) =>
        logger.warn('Could not queue indexing for a new conversation', { code: error.code })
      );
    }
  }
  const conversation = await Conversation.create({
    user: userId,
    scope,
    source: scope === 'source' ? sourceId : null,
    ...(title && { title }),
  });
  return toConversationJSON(conversation, userId);
}

async function listConversations({ userId, sourceId, scope, page = 1, limit = 20 }) {
  const filter = { user: userId };
  if (sourceId) filter.source = sourceId;
  if (scope) filter.scope = scope;
  const [items, total] = await Promise.all([
    Conversation.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit),
    Conversation.countDocuments(filter),
  ]);
  return {
    items: await Promise.all(items.map((c) => toConversationJSON(c, userId))),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getConversation({ userId, conversationId }) {
  const conversation = await findOwnedConversation(userId, conversationId);
  const messages = await Message.find({ conversation: conversation._id, user: userId }).sort({ createdAt: 1 }).limit(500);
  return { conversation: await toConversationJSON(conversation, userId), messages: messages.map((m) => m.toJSON()) };
}

async function renameConversation({ userId, conversationId, title }) {
  const conversation = await Conversation.findOneAndUpdate({ _id: conversationId, user: userId }, { $set: { title } }, { new: true });
  if (!conversation) throw ApiError.notFound('Conversation not found.', 'CONVERSATION_NOT_FOUND');
  return toConversationJSON(conversation, userId);
}

async function deleteConversation({ userId, conversationId }) {
  const conversation = await findOwnedConversation(userId, conversationId);
  await Message.deleteMany({ conversation: conversation._id, user: userId });
  await Conversation.deleteOne({ _id: conversation._id, user: userId });
}

/* -------------------------------- Messages -------------------------------- */

/** A short follow-up ("and why?") is searched together with the previous question. */
function retrievalQuery(content, history) {
  const previous = [...history].reverse().find((m) => m.role === 'user');
  return content.length < 80 && previous ? `${previous.content.slice(0, 300)}\n${content}` : content;
}

async function loadTitles(userId, sourceIds) {
  const sources = await Source.find({ _id: { $in: sourceIds }, user: userId }).select('metadata summary').lean();
  const summaries = await Summary.find({ source: { $in: sourceIds }, user: userId }).select('source title').lean();
  const summaryTitle = new Map(summaries.map((s) => [String(s.source), s.title]));
  return new Map(sources.map((s) => [String(s._id), s.metadata?.title || summaryTitle.get(String(s._id)) || 'Untitled']));
}

/** The answer to a question submitted earlier with the same clientRequestId (idempotent re-submission). */
async function findAnswered(userId, conversation, clientRequestId) {
  if (!clientRequestId) return null;
  const question = await Message.findOne({ conversation: conversation._id, user: userId, clientRequestId, role: 'user' });
  if (!question) return null;
  const answer = await Message.findOne({
    conversation: conversation._id,
    user: userId,
    role: 'assistant',
    createdAt: { $gte: question.createdAt },
  }).sort({ createdAt: 1 });
  return answer ? { question, answer } : null;
}

/**
 * Ask a question. Accidental double submissions are absorbed: a question that is
 * already being answered in this conversation returns 409, and re-sending the same
 * clientRequestId returns the stored answer without another AI call.
 */
async function sendMessage({ userId, conversationId, content, clientRequestId }) {
  const conversation = await findOwnedConversation(userId, conversationId);
  const previous = await findAnswered(userId, conversation, clientRequestId);
  if (previous) {
    return {
      conversation: await toConversationJSON(conversation, userId),
      messages: [previous.question.toJSON(), previous.answer.toJSON()],
      retrieval: { mode: 'cached', chunks: 0 },
      duplicate: true,
    };
  }
  const lockName = `chat:${conversation.id}`;
  if (!(await aiGate.acquireLock(lockName, 120000))) {
    throw ApiError.conflict('Your previous question in this conversation is still being answered.', 'ANSWER_IN_PROGRESS');
  }
  try {
    return await aiGate.runWithAiContext({ feature: 'chat', userId: String(userId), waitForSlotMs: 8000 }, () =>
      answerInConversation({ userId, conversation, content, clientRequestId })
    );
  } finally {
    await aiGate.releaseLock(lockName).catch(() => {});
  }
}

async function answerInConversation({ userId, conversation, content, clientRequestId }) {
  // Fail fast (no embedding request) when Gemini generation is currently blocked.
  try {
    await aiGate.assertAvailable(aiGate.KINDS.GENERATION, 'answer');
  } catch (error) {
    throw toApiError(error, 'chat');
  }

  let scopeTitle = null;
  if (conversation.scope === 'source') {
    const source = await Source.findOne({ _id: conversation.source, user: userId }).select('metadata summary rag status');
    if (!source) throw ApiError.notFound('The source of this conversation no longer exists.', 'SOURCE_NOT_FOUND');
    const hasChunks = await ContentChunk.exists({ source: source._id, user: userId });
    if (!hasChunks) {
      if ([RAG_STATUSES.NONE, RAG_STATUSES.FAILED].includes(source.rag?.status || RAG_STATUSES.NONE)) {
        await scheduleIndexing({ sourceId: source._id, userId }).catch(() => null);
      }
      throw ApiError.conflict(
        'This source is still being prepared for questions. Please try again in a moment.',
        'SOURCE_NOT_INDEXED'
      );
    }
    scopeTitle = (await loadTitles(userId, [source._id])).get(String(source._id));
  }

  const history = (
    await Message.find({ conversation: conversation._id, user: userId })
      .sort({ createdAt: -1 })
      .limit(config.rag.chatHistoryMessages)
      .select('role content')
      .lean()
  ).reverse();

  const { chunks, mode } = await retrieve({
    userId,
    query: retrievalQuery(content, history),
    sourceIds: conversation.scope === 'source' ? [conversation.source] : undefined,
    minScore: config.rag.chatMinScore,
  });

  const titles = await loadTitles(userId, [...new Set(chunks.map((c) => String(c.source)))]);
  const byId = new Map(chunks.map((chunk, i) => [`c${i + 1}`, chunk]));

  const userMessage = await Message.create({
    user: userId,
    conversation: conversation._id,
    role: 'user',
    content,
    ...(clientRequestId && { clientRequestId }),
  });

  let parsed;
  try {
    const raw = await processingClient.answerQuestion({
      question: content,
      history: history.map((m) => ({ role: m.role, content: m.content.slice(0, HISTORY_CHARS) })),
      chunks: [...byId.entries()].map(([id, c]) => ({
        id,
        text: c.text,
        label: c.label,
        sourceId: String(c.source),
        sourceTitle: titles.get(String(c.source)),
        sourceKind: c.kind,
      })),
      scope: conversation.scope,
      scopeTitle,
    });
    parsed = answerResultSchema.safeParse(raw);
    if (!parsed.success) throw new ApiError(502, 'AI_INVALID_RESPONSE', 'The AI returned an unusable answer. Please try again.');
  } catch (error) {
    // Keep the conversation consistent: a question without an answer is removed, so it can be re-asked.
    await Message.deleteOne({ _id: userMessage._id });
    throw toApiError(error, 'chat');
  }

  const { answer, model, usage } = parsed.data;
  const citations = answer.citations
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((c) => ({
      source: c.source,
      sourceTitle: titles.get(String(c.source)) || null,
      sourceKind: c.kind,
      chunk: c._id,
      label: c.label || null,
      page: c.page ?? null,
      section: c.section ?? null,
      startSeconds: c.startSeconds ?? null,
      snippet: c.text.slice(0, 280),
    }));

  const assistant = await Message.create({
    user: userId,
    conversation: conversation._id,
    role: 'assistant',
    content: answer.answer,
    support: answer.support,
    citations,
    followUps: answer.follow_up_questions,
    model,
    usage: { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null },
  });

  const update = { $inc: { messageCount: 2 }, $set: { lastMessageAt: new Date() } };
  if (conversation.messageCount === 0 && conversation.title === 'New conversation') {
    update.$set.title = content.replace(/\s+/g, ' ').slice(0, 80);
  }
  const updated = await Conversation.findOneAndUpdate({ _id: conversation._id, user: userId }, update, { new: true });

  return {
    conversation: await toConversationJSON(updated, userId),
    messages: [userMessage.toJSON(), assistant.toJSON()],
    retrieval: { mode, chunks: chunks.length },
  };
}

module.exports = {
  createConversation,
  listConversations,
  getConversation,
  renameConversation,
  deleteConversation,
  sendMessage,
  retrievalQuery,
};
