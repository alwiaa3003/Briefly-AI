'use strict';

const { z } = require('zod');
const { SUMMARY_STYLES, QUIZ_DIFFICULTIES, QUESTION_TYPES } = require('../queues/constants');

/*
 * 1. Defence-in-depth validation of AI results from the processing service
 *    (the Python side validates Gemini output; this guards the database contract).
 * 2. Validation of the public Ask AI / search / study endpoints.
 */

const text = (min, max) => z.string().trim().min(min).max(max);
const refs = z.array(z.string().max(64)).max(8).default([]);
const usage = z
  .object({
    input_tokens: z.number().int().nonnegative().nullable().optional(),
    output_tokens: z.number().int().nonnegative().nullable().optional(),
  })
  .optional();
const provenance = {
  model: text(1, 100),
  prompt_version: text(1, 50),
  refs_discarded: z.number().int().nonnegative().optional(),
  input_characters: z.number().int().nonnegative().optional(),
  usage,
};

const embedResultSchema = z.object({
  vectors: z.array(z.array(z.number().finite())).min(1),
  model: text(1, 100),
  dimensions: z.number().int().positive(),
  provider: text(1, 40),
});

const answerResultSchema = z.object({
  answer: z.object({
    answer: text(1, 6000),
    support: z.enum(['supported', 'partial', 'not_found']),
    citations: z.array(z.string().max(64)).max(12),
    follow_up_questions: z.array(text(1, 300)).max(3),
  }),
  model: text(1, 100),
  citations_discarded: z.number().int().nonnegative().optional(),
  usage,
});

const term = z.object({ term: text(1, 200), explanation: text(1, 1500), refs });
const item = z.object({ text: text(1, 1200), refs });

const notesResultSchema = z.object({
  notes: z.object({
    title: text(1, 300),
    overview: text(1, 3000),
    key_concepts: z.array(term).min(1).max(25),
    definitions: z.array(term).max(30),
    key_facts: z.array(item).max(30),
    examples: z.array(item).max(20),
    formulas: z.array(item).max(20),
    revision_points: z.array(item).min(1).max(25),
    external_knowledge: z.array(text(1, 1500)).max(10),
  }),
  ...provenance,
});

const questionSchema = z
  .object({
    id: text(1, 20),
    type: z.enum(QUESTION_TYPES),
    question: text(1, 1000),
    options: z.array(text(1, 500)).max(6),
    correct_option: z.number().int().nonnegative().nullable(),
    correct_boolean: z.boolean().nullable(),
    accepted_answers: z.array(text(1, 300)).max(8),
    explanation: text(1, 1500),
    refs,
  })
  .refine(
    (q) =>
      (q.type === 'multiple_choice' && q.options.length >= 3 && q.correct_option !== null && q.correct_option < q.options.length) ||
      (q.type === 'true_false' && q.correct_boolean !== null) ||
      (q.type === 'short_answer' && q.accepted_answers.length > 0),
    { message: 'inconsistent question' }
  );

const quizResultSchema = z.object({
  quiz: z.object({ title: text(1, 300), questions: z.array(questionSchema).min(1).max(30) }),
  ...provenance,
});

const flashcardsResultSchema = z.object({
  flashcards: z.object({
    cards: z.array(z.object({ id: text(1, 20), front: text(1, 600), back: text(1, 1500), refs })).min(1).max(60),
  }),
  ...provenance,
});

const restyleResultSchema = z.object({
  summary: z.object({
    title: text(1, 300),
    overview: text(1, 3000),
    sections: z.array(z.object({ heading: text(1, 200), content: text(1, 8000) })).min(1).max(15),
    key_points: z.array(text(1, 1000)).max(20),
  }),
  style: z.enum(SUMMARY_STYLES),
  ...provenance,
});

/* ------------------------------ Public API ------------------------------ */

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');
const idParams = z.object({ id: objectId });

const createConversationSchema = z
  .object({
    scope: z.enum(['source', 'library']),
    sourceId: objectId.optional(),
    title: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => v.scope === 'library' || Boolean(v.sourceId), {
    message: 'Choose a source for this conversation.',
    path: ['sourceId'],
  });

const listConversationsQuerySchema = z.object({
  sourceId: objectId.optional(),
  scope: z.enum(['source', 'library']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const renameConversationSchema = z.object({ title: z.string().trim().min(1, 'Enter a title.').max(120) });

function sendMessageSchema(maxChars) {
  return z.object({
    content: z
      .string({ required_error: 'Enter a question.' })
      .trim()
      .min(1, 'Enter a question.')
      .max(maxChars, `Questions can be at most ${maxChars} characters.`),
    clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid request id.').optional(),
  });
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
  .optional();

const searchQuerySchema = z.object({
  q: z.string({ required_error: 'Enter a search.' }).trim().min(2, 'Enter at least 2 characters.').max(300),
  kind: z.enum(['article', 'youtube', 'video', 'document']).optional(),
  from: isoDate,
  to: isoDate,
  limit: z.coerce.number().int().min(1).max(30).default(10),
});

const quizRequestSchema = z.object({
  count: z.coerce.number().int().min(3).max(30).optional(),
  difficulty: z.enum(QUIZ_DIFFICULTIES).optional(),
  types: z.array(z.enum(QUESTION_TYPES)).min(1).max(3).optional(),
  regenerate: z.boolean().optional(),
});

const flashcardRequestSchema = z.object({ count: z.coerce.number().int().min(5).max(60).optional() });
const styleParams = z.object({ id: objectId, style: z.enum(SUMMARY_STYLES) });
const regenerateSchema = z.object({ regenerate: z.boolean().optional() });

const attemptSchema = z.object({
  answers: z
    .record(z.string().max(20), z.union([z.number().int().min(0).max(10), z.boolean(), z.string().max(500), z.null()]))
    .refine((v) => Object.keys(v).length <= 30, 'Too many answers.'),
});

const cardReviewParams = z.object({ id: objectId, cardId: z.string().regex(/^[a-z0-9]{1,20}$/i, 'Invalid card.') });
const cardReviewSchema = z.object({ status: z.enum(['learning', 'known']) });

const preferencesSchema = z
  .object({
    summaryStyle: z.enum(['standard', ...SUMMARY_STYLES]).optional(),
    quizDifficulty: z.enum(QUIZ_DIFFICULTIES).optional(),
    quizQuestionCount: z.number().int().min(3).max(30).optional(),
    quizQuestionTypes: z.array(z.enum(QUESTION_TYPES)).min(1).max(3).optional(),
    flashcardCount: z.number().int().min(5).max(60).optional(),
  })
  .strict();

module.exports = {
  embedResultSchema,
  answerResultSchema,
  notesResultSchema,
  quizResultSchema,
  flashcardsResultSchema,
  restyleResultSchema,
  objectId,
  idParams,
  createConversationSchema,
  listConversationsQuerySchema,
  renameConversationSchema,
  sendMessageSchema,
  searchQuerySchema,
  quizRequestSchema,
  flashcardRequestSchema,
  styleParams,
  regenerateSchema,
  attemptSchema,
  cardReviewParams,
  cardReviewSchema,
  preferencesSchema,
};
