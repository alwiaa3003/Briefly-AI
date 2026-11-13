'use strict';

/** Study notes, quizzes, flashcards, summary styles and preferences (API + real job handlers). */

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return { ...actual, generateStudy: jest.fn() };
});

const request = require('supertest');
const processingClient = require('../src/services/processingClient');
const queueMock = require('./helpers/queueMock');
const { createApp } = require('../src/app');
const Source = require('../src/models/Source');
const Summary = require('../src/models/Summary');
const DocumentPart = require('../src/models/DocumentPart');
const ProcessingJob = require('../src/models/ProcessingJob');
const { processJob } = require('../src/workers/processor');
const { gradeShortAnswer } = require('../src/services/studyService');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
let counter = 0;
async function signUp() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Student Person', email: `study${counter}@example.com`, password: 'reading123' });
  return { userId: res.body.data.user.id, auth: { Authorization: `Bearer ${res.body.data.accessToken}` } };
}

const prov = { model: 'fake-gemini', prompt_version: 'study-v1', refs_discarded: 0, input_characters: 900, usage: { input_tokens: 1, output_tokens: 1 } };
const NOTES = {
  notes: {
    title: 'Urban Heat',
    overview: 'Trees cool cities through shade and evapotranspiration.',
    key_concepts: [{ term: 'Canopy', explanation: 'Tree cover.', refs: ['c1'] }],
    definitions: [],
    key_facts: [{ text: 'Streets are 2 degrees cooler.', refs: ['c2'] }],
    examples: [],
    formulas: [],
    revision_points: [{ text: 'Shade matters.', refs: ['c1', 'c77'] }],
    external_knowledge: ['Trees also store carbon.'],
  },
  ...prov,
};
const QUIZ = {
  quiz: {
    title: 'Urban Heat quiz',
    questions: [
      { id: 'q1', type: 'multiple_choice', question: 'What cools?', options: ['Trees', 'Cars', 'Roads', 'Glass'], correct_option: 0, correct_boolean: null, accepted_answers: [], explanation: 'Trees give shade.', refs: ['c1'] },
      { id: 'q2', type: 'true_false', question: 'Shade is equal everywhere.', options: [], correct_option: null, correct_boolean: false, accepted_answers: [], explanation: 'It is unequal.', refs: ['c2'] },
      { id: 'q3', type: 'short_answer', question: 'Which process releases water vapour?', options: [], correct_option: null, correct_boolean: null, accepted_answers: ['evapotranspiration'], explanation: 'Leaves release vapour.', refs: [] },
    ],
  },
  ...prov,
};
const CARDS = {
  flashcards: { cards: [{ id: 'f1', front: 'Canopy?', back: 'Tree cover.', refs: ['c1'] }, { id: 'f2', front: 'Effect?', back: 'Cooling.', refs: [] }] },
  ...prov,
};
const STYLE = (style) => ({
  summary: { title: 'Urban Heat', overview: 'Trees cool cities.', sections: [{ heading: 'Cooling', content: '- Shade' }], key_points: ['Trees cool.'] },
  style,
  ...prov,
});

beforeAll(startTestDatabase);
beforeEach(() => queueMock.__reset());
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

async function docSource(userId) {
  const source = await Source.create({
    user: userId,
    kind: 'document',
    normalizedUrl: `upload:${Math.random()}`,
    metadata: { title: 'Urban Heat Report' },
    document: { format: 'pdf' },
    status: 'completed',
  });
  await DocumentPart.insertMany(
    [1, 2, 3].map((page) => ({
      user: userId,
      source: source._id,
      index: page - 1,
      page,
      blocks: [{ kind: 'paragraph', text: `Page ${page}: urban trees cool streets through shade and evapotranspiration. `.repeat(3) }],
    }))
  );
  const summary = await Summary.create({ user: userId, source: source._id, title: 'Urban Heat', overview: 'Overview of urban heat.', model: 'f', promptVersion: 'v' });
  await Source.updateOne({ _id: source._id }, { $set: { summary: summary._id } });
  return source;
}

/** Runs the most recently queued job through the real processor. */
async function runQueuedJob() {
  const queued = queueMock.__state.added[queueMock.__state.added.length - 1];
  const job = await ProcessingJob.findById(queued.data.processingJobId);
  return processJob({ data: queued.data, attemptsMade: job.attempts, opts: { attempts: 3 } });
}

describe('study notes', () => {
  test('generate -> queued job -> grounded notes with resolved page refs', async () => {
    const { userId, auth } = await signUp();
    const source = await docSource(userId);
    const res = await request(app).post(`/api/sources/${source.id}/notes`).set(auth).send({});
    expect(res.status).toBe(202);
    expect(res.body.data.item.status).toBe('queued');
    expect(queueMock.__state.added[0].type).toBe('generate_study_notes');

    processingClient.generateStudy.mockResolvedValue(NOTES);
    await runQueuedJob();
    const [tool, payload] = processingClient.generateStudy.mock.calls[0];
    expect(tool).toBe('notes');
    expect(payload.chunks.map((c) => c.id)).toEqual(payload.chunks.map((_, i) => `c${i + 1}`));
    expect(payload.chunks[0].label).toBe('p. 1');
    expect(payload.summaryOverview).toBe('Overview of urban heat.');

    const notes = (await request(app).get(`/api/sources/${source.id}/notes`).set(auth)).body.data.item;
    expect(notes.status).toBe('completed');
    expect(notes.keyConcepts[0].refs).toEqual([{ label: 'p. 1', page: 1, section: null, startSeconds: null }]);
    expect(notes.revisionPoints[0].refs).toHaveLength(1); // c77 was never supplied
    expect(notes.externalKnowledge).toEqual(['Trees also store carbon.']);
  });

  test('existing notes are reused unless regenerate is requested', async () => {
    const { userId, auth } = await signUp();
    const source = await docSource(userId);
    await request(app).post(`/api/sources/${source.id}/notes`).set(auth).send({});
    processingClient.generateStudy.mockResolvedValue(NOTES);
    await runQueuedJob();
    const again = await request(app).post(`/api/sources/${source.id}/notes`).set(auth).send({});
    expect(again.status).toBe(200);
    expect(queueMock.__state.added).toHaveLength(1);
    const regen = await request(app).post(`/api/sources/${source.id}/notes`).set(auth).send({ regenerate: true });
    expect(regen.status).toBe(202);
    expect(queueMock.__state.added).toHaveLength(2);
  });

  test('final failure marks the notes failed with a safe error', async () => {
    const { userId, auth } = await signUp();
    const source = await docSource(userId);
    await request(app).post(`/api/sources/${source.id}/notes`).set(auth).send({});
    processingClient.generateStudy.mockRejectedValue(
      new processingClient.ProcessingServiceError('AI features are not configured on the server.', { code: 'AI_NOT_CONFIGURED', retryable: false })
    );
    await expect(runQueuedJob()).rejects.toThrow();
    const notes = (await request(app).get(`/api/sources/${source.id}/notes`).set(auth)).body.data.item;
    expect(notes.status).toBe('failed');
    expect(notes.error.code).toBe('AI_NOT_CONFIGURED');
  });

  test('another user cannot generate or read study material for my source', async () => {
    const owner = await signUp();
    const other = await signUp();
    const source = await docSource(owner.userId);
    expect((await request(app).post(`/api/sources/${source.id}/notes`).set(other.auth).send({})).status).toBe(404);
    expect((await request(app).get(`/api/sources/${source.id}/notes`).set(other.auth)).body.data.item).toBeNull();
    expect((await request(app).post(`/api/sources/${source.id}/quizzes`).set(other.auth).send({})).status).toBe(404);
    expect((await request(app).post(`/api/sources/${source.id}/summary-styles/concise`).set(other.auth).send({})).status).toBe(404);
  });

  test('sources that are not completed cannot be studied', async () => {
    const { userId, auth } = await signUp();
    const source = await docSource(userId);
    await Source.updateOne({ _id: source._id }, { $set: { status: 'extracting' } });
    expect((await request(app).post(`/api/sources/${source.id}/notes`).set(auth).send({})).status).toBe(409);
  });
});

describe('quizzes', () => {
  async function readyQuiz() {
    const user = await signUp();
    const source = await docSource(user.userId);
    const created = await request(app)
      .post(`/api/sources/${source.id}/quizzes`)
      .set(user.auth)
      .send({ count: 3, difficulty: 'hard', types: ['multiple_choice', 'true_false', 'short_answer'] });
    expect(created.status).toBe(202);
    processingClient.generateStudy.mockResolvedValue(QUIZ);
    await runQueuedJob();
    return { ...user, source, quizId: created.body.data.item.id };
  }

  test('generation options are forwarded and answers are hidden before submission', async () => {
    const { auth, quizId } = await readyQuiz();
    expect(processingClient.generateStudy.mock.calls[0][1].options).toEqual({
      count: 3,
      difficulty: 'hard',
      types: ['multiple_choice', 'short_answer', 'true_false'],
    });
    const quiz = (await request(app).get(`/api/quizzes/${quizId}`).set(auth)).body.data.item;
    expect(quiz.status).toBe('completed');
    expect(quiz.questions).toHaveLength(3);
    const body = JSON.stringify(quiz);
    expect(body).not.toMatch(/correctOption|correctBoolean|acceptedAnswers|explanation|evapotranspiration/);
  });

  test('submission is scored server-side and returns the review', async () => {
    const { auth, quizId } = await readyQuiz();
    const res = await request(app)
      .post(`/api/quizzes/${quizId}/attempts`)
      .set(auth)
      .send({ answers: { q1: 0, q2: true, q3: 'It is Evapotranspiration.' } });
    expect(res.status).toBe(201);
    expect(res.body.data.attempt).toMatchObject({ score: 2, total: 3 });
    const review = res.body.data.questions;
    expect(review.map((q) => q.correct)).toEqual([true, false, true]);
    expect(review[1]).toMatchObject({ correctBoolean: false, explanation: 'It is unequal.', response: true });
    expect(review[0].refs[0]).toMatchObject({ page: 1 });

    const quiz = (await request(app).get(`/api/quizzes/${quizId}`).set(auth)).body.data.item;
    expect(quiz).toMatchObject({ attemptCount: 1, bestScore: 67 });
    const attempts = (await request(app).get(`/api/quizzes/${quizId}/attempts`).set(auth)).body.data.items;
    expect(attempts).toHaveLength(1);
    const again = await request(app).get(`/api/quizzes/${quizId}/attempts/${attempts[0].id}`).set(auth);
    expect(again.body.data.questions).toHaveLength(3);
  });

  test('unanswered and wrong-type answers are incorrect; retry is allowed', async () => {
    const { auth, quizId } = await readyQuiz();
    const res = await request(app).post(`/api/quizzes/${quizId}/attempts`).set(auth).send({ answers: { q1: 'Trees', q2: 'false' } });
    expect(res.body.data.attempt.score).toBe(0);
    const retry = await request(app).post(`/api/quizzes/${quizId}/attempts`).set(auth).send({ answers: { q1: 0, q2: false, q3: 'evapotranspiration' } });
    expect(retry.body.data.attempt.score).toBe(3);
    expect((await request(app).get(`/api/quizzes/${quizId}`).set(auth)).body.data.item.bestScore).toBe(100);
  });

  test('other users cannot see, answer or delete a quiz', async () => {
    const { quizId } = await readyQuiz();
    const other = await signUp();
    expect((await request(app).get(`/api/quizzes/${quizId}`).set(other.auth)).status).toBe(404);
    expect((await request(app).post(`/api/quizzes/${quizId}/attempts`).set(other.auth).send({ answers: {} })).status).toBe(404);
    expect((await request(app).delete(`/api/quizzes/${quizId}`).set(other.auth)).status).toBe(404);
  });

  test('a quiz that is still generating cannot be submitted; validation of options', async () => {
    const { userId, auth } = await signUp();
    const source = await docSource(userId);
    const created = await request(app).post(`/api/sources/${source.id}/quizzes`).set(auth).send({});
    expect(created.body.data.item).toMatchObject({ requestedCount: 10, difficulty: 'medium' }); // preference defaults
    const res = await request(app).post(`/api/quizzes/${created.body.data.item.id}/attempts`).set(auth).send({ answers: {} });
    expect(res.status).toBe(409);
    expect((await request(app).post(`/api/sources/${source.id}/quizzes`).set(auth).send({ count: 99 })).status).toBe(400);
    expect((await request(app).post(`/api/sources/${source.id}/quizzes`).set(auth).send({ types: ['essay'] })).status).toBe(400);
  });

  test('delete removes the quiz and its attempts', async () => {
    const { auth, quizId, source } = await readyQuiz();
    await request(app).post(`/api/quizzes/${quizId}/attempts`).set(auth).send({ answers: { q1: 0 } });
    expect((await request(app).delete(`/api/quizzes/${quizId}`).set(auth)).status).toBe(200);
    expect((await request(app).get(`/api/sources/${source.id}/quizzes`).set(auth)).body.data.items).toEqual([]);
  });
});

describe('short answer grading', () => {
  test.each([
    ['evapotranspiration', ['evapotranspiration'], true],
    ['  Evapotranspiration! ', ['evapotranspiration'], true],
    ['it is the evapotranspiration process', ['evapotranspiration'], true],
    ['the urban heat island', ['urban heat island effect'], false],
    ['heat island effect urban', ['urban heat island effect'], true],
    ['photosynthesis', ['evapotranspiration'], false],
    ['', ['x'], false],
    ['café', ['cafe'], true],
  ])('%s vs %j -> %s', (answer, accepted, expected) => {
    expect(gradeShortAnswer(answer, accepted)).toBe(expected);
  });
});

describe('flashcards', () => {
  test('generate, flip-review tracking and reset', async () => {
    const { userId, auth } = await signUp();
    const source = await docSource(userId);
    const created = await request(app).post(`/api/sources/${source.id}/flashcards`).set(auth).send({ count: 12 });
    expect(created.status).toBe(202);
    processingClient.generateStudy.mockResolvedValue(CARDS);
    await runQueuedJob();
    expect(processingClient.generateStudy.mock.calls[0][1].options).toEqual({ count: 12 });

    const deck = (await request(app).get(`/api/sources/${source.id}/flashcards`).set(auth)).body.data.item;
    expect(deck.cards).toHaveLength(2);
    expect(deck.cards[0].review.status).toBe('new');

    const reviewed = await request(app).post(`/api/flashcards/${deck.id}/cards/f1/review`).set(auth).send({ status: 'known' });
    expect(reviewed.body.data.item.cards[0].review).toMatchObject({ status: 'known', reviews: 1 });
    expect((await request(app).post(`/api/flashcards/${deck.id}/cards/f9/review`).set(auth).send({ status: 'known' })).status).toBe(404);

    const reset = await request(app).post(`/api/flashcards/${deck.id}/reset`).set(auth);
    expect(reset.body.data.item.cards.every((c) => c.review.status === 'new' && c.review.reviews === 0)).toBe(true);

    const other = await signUp();
    expect((await request(app).post(`/api/flashcards/${deck.id}/cards/f1/review`).set(other.auth).send({ status: 'known' })).status).toBe(404);
  });
});

describe('summary styles', () => {
  test('each style is generated once from stored content, without reprocessing the source', async () => {
    const { userId, auth } = await signUp();
    const source = await docSource(userId);
    const res = await request(app).post(`/api/sources/${source.id}/summary-styles/exam_revision`).set(auth).send({});
    expect(res.status).toBe(202);
    expect(queueMock.__state.added.map((j) => j.type)).toEqual(['generate_summary_style']);
    processingClient.generateStudy.mockResolvedValue(STYLE('exam_revision'));
    await runQueuedJob();
    expect(processingClient.generateStudy.mock.calls[0][0]).toBe('style');
    expect(processingClient.generateStudy.mock.calls[0][1].options).toEqual({ style: 'exam_revision' });

    const item = (await request(app).get(`/api/sources/${source.id}/summary-styles/exam_revision`).set(auth)).body.data.item;
    expect(item).toMatchObject({ status: 'completed', style: 'exam_revision', keyPoints: ['Trees cool.'] });
    expect((await request(app).get(`/api/sources/${source.id}/summary-styles`).set(auth)).body.data.items).toHaveLength(1);
    // The source itself was not touched.
    expect((await Source.findById(source._id)).status).toBe('completed');
    expect((await request(app).post(`/api/sources/${source.id}/summary-styles/poetry`).set(auth).send({})).status).toBe(400);
  });
});

describe('preferences', () => {
  test('defaults, update, validation and isolation', async () => {
    const a = await signUp();
    const b = await signUp();
    const defaults = (await request(app).get('/api/preferences').set(a.auth)).body.data.preferences;
    expect(defaults).toMatchObject({ summaryStyle: 'standard', quizDifficulty: 'medium', quizQuestionCount: 10, flashcardCount: 20 });
    const updated = await request(app).put('/api/preferences').set(a.auth).send({ summaryStyle: 'beginner', quizQuestionCount: 5 });
    expect(updated.body.data.preferences).toMatchObject({ summaryStyle: 'beginner', quizQuestionCount: 5 });
    expect((await request(app).put('/api/preferences').set(a.auth).send({ quizQuestionCount: 500 })).status).toBe(400);
    expect((await request(app).put('/api/preferences').set(a.auth).send({ user: b.userId })).status).toBe(400);
    expect((await request(app).get('/api/preferences').set(b.auth)).body.data.preferences.summaryStyle).toBe('standard');
  });
});
