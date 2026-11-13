'use strict';

const { UnrecoverableError } = require('bullmq');
const StudyNote = require('../../models/StudyNote');
const Quiz = require('../../models/Quiz');
const FlashcardDeck = require('../../models/FlashcardDeck');
const SummaryVariant = require('../../models/SummaryVariant');
const processingClient = require('../../services/processingClient');
const { ProcessingServiceError } = processingClient;
const { loadSourceContent, sourceTitle, chunksFor } = require('../../services/rag/sourceContent');
const { sampleChunks } = require('../../services/rag/chunker');
const validators = require('../../validators/aiValidators');
const config = require('../../config/env');
const { JOB_TYPES, GENERATION_STATUSES, SOURCE_STATUSES } = require('../../queues/constants');

/*
 * Study tools run as background jobs: they can take a minute and cost AI calls.
 * Each job targets an existing document (created in "queued" state by
 * studyService) and fills it. Input to the model is a representative, in-order
 * sample of the source's stored chunks (never the whole raw source) and every
 * reference returned is resolved to a real page / timestamp / section.
 */

const mapTerms = (items, resolve) => items.map((t) => ({ term: t.term, explanation: t.explanation, refs: resolve(t.refs) }));
const mapItems = (items, resolve) => items.map((t) => ({ text: t.text, refs: resolve(t.refs) }));

const SPECS = {
  [JOB_TYPES.GENERATE_STUDY_NOTES]: {
    tool: 'notes',
    Model: StudyNote,
    schema: validators.notesResultSchema,
    options: () => ({}),
    apply: ({ notes }, resolve) => ({
      title: notes.title,
      overview: notes.overview,
      keyConcepts: mapTerms(notes.key_concepts, resolve),
      definitions: mapTerms(notes.definitions, resolve),
      keyFacts: mapItems(notes.key_facts, resolve),
      examples: mapItems(notes.examples, resolve),
      formulas: mapItems(notes.formulas, resolve),
      revisionPoints: mapItems(notes.revision_points, resolve),
      externalKnowledge: notes.external_knowledge,
    }),
  },
  [JOB_TYPES.GENERATE_QUIZ]: {
    tool: 'quiz',
    Model: Quiz,
    schema: validators.quizResultSchema,
    options: (doc) => ({ count: doc.requestedCount, difficulty: doc.difficulty, types: doc.types }),
    apply: ({ quiz }, resolve) => ({
      title: quiz.title,
      questions: quiz.questions.map((q) => ({
        id: q.id,
        type: q.type,
        question: q.question,
        options: q.type === 'multiple_choice' ? q.options : [],
        correctOption: q.type === 'multiple_choice' ? q.correct_option : null,
        correctBoolean: q.type === 'true_false' ? q.correct_boolean : null,
        acceptedAnswers: q.type === 'short_answer' ? q.accepted_answers : [],
        explanation: q.explanation,
        refs: resolve(q.refs),
      })),
    }),
  },
  [JOB_TYPES.GENERATE_FLASHCARDS]: {
    tool: 'flashcards',
    Model: FlashcardDeck,
    schema: validators.flashcardsResultSchema,
    options: (doc) => ({ count: doc.requestedCount }),
    apply: ({ flashcards }, resolve) => ({
      cards: flashcards.cards.map((c) => ({
        id: c.id,
        front: c.front,
        back: c.back,
        refs: resolve(c.refs),
        review: { status: 'new', reviews: 0, lastReviewedAt: null },
      })),
    }),
  },
  [JOB_TYPES.GENERATE_SUMMARY_STYLE]: {
    tool: 'style',
    Model: SummaryVariant,
    schema: validators.restyleResultSchema,
    options: (doc) => ({ style: doc.style }),
    apply: ({ summary }) => ({
      title: summary.title,
      overview: summary.overview,
      sections: summary.sections,
      keyPoints: summary.key_points,
    }),
  },
};

function makeStudyHandler(type) {
  const spec = SPECS[type];

  async function handleStudy({ input }) {
    const doc = await spec.Model.findOne({ _id: input.targetId, user: input.userId });
    if (!doc) throw new UnrecoverableError('The study item no longer exists.');
    const loaded = await loadSourceContent(doc.source, input.userId);
    if (!loaded || loaded.source.status !== SOURCE_STATUSES.COMPLETED) {
      throw new UnrecoverableError('The source is not available.');
    }
    await spec.Model.updateOne({ _id: doc._id }, { $set: { status: GENERATION_STATUSES.GENERATING, error: null } });

    const content = chunksFor(loaded).filter((c) => c.chunkType === 'content');
    if (!content.length) {
      throw new ProcessingServiceError('This source has no stored text to study from.', {
        code: 'AI_NO_CONTENT',
        retryable: false,
      });
    }
    const selected = sampleChunks(content, config.rag.studyInputChars).slice(0, 400);
    const byId = new Map(selected.map((chunk, i) => [`c${i + 1}`, chunk]));
    const resolve = (refs = []) =>
      refs
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((c) => ({ label: c.label || null, page: c.page ?? null, section: c.section ?? null, startSeconds: c.startSeconds ?? null }));

    const raw = await processingClient.generateStudy(spec.tool, {
      title: sourceTitle(loaded.source, loaded.summary),
      sourceKind: loaded.source.kind,
      summaryOverview: loaded.summary?.overview,
      chunks: [...byId.entries()].map(([id, c]) => ({
        id,
        text: c.text,
        label: c.label,
        sourceId: loaded.source.id,
        sourceTitle: null,
        sourceKind: loaded.source.kind,
      })),
      options: spec.options(doc),
    });
    const parsed = spec.schema.safeParse(raw);
    if (!parsed.success) {
      throw new ProcessingServiceError('The generated study material could not be used.', {
        code: 'AI_INVALID_RESPONSE',
        retryable: false,
      });
    }

    await spec.Model.updateOne(
      { _id: doc._id, user: input.userId },
      {
        $set: {
          ...spec.apply(parsed.data, resolve),
          status: GENERATION_STATUSES.COMPLETED,
          error: null,
          model: parsed.data.model,
          promptVersion: parsed.data.prompt_version,
          inputCharacters: parsed.data.input_characters ?? null,
          usage: {
            inputTokens: parsed.data.usage?.input_tokens ?? null,
            outputTokens: parsed.data.usage?.output_tokens ?? null,
          },
          generatedAt: new Date(),
          sourceContentHash: loaded.source.rag?.contentHash || null,
        },
      },
      { runValidators: true }
    );
    return { targetId: String(doc._id) };
  }

  // Waiting for AI capacity: visible as "queued" with the reason; it continues automatically.
  handleStudy.onDeferred = async ({ input, error, until }) => {
    await spec.Model.updateOne(
      { _id: input.targetId, status: { $ne: GENERATION_STATUSES.COMPLETED } },
      { $set: { status: GENERATION_STATUSES.QUEUED, error: { ...error, nextAttemptAt: until } } }
    );
  };

  handleStudy.onFinalFailure = async ({ input, error }) => {
    await spec.Model.updateOne(
      { _id: input.targetId, status: { $ne: GENERATION_STATUSES.COMPLETED } },
      { $set: { status: GENERATION_STATUSES.FAILED, error } }
    );
  };
  return handleStudy;
}

module.exports = { makeStudyHandler, SPECS };
