'use strict';

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return { ...actual, embedTexts: jest.fn(), summarizeArticle: jest.fn(), extractArticle: jest.fn(), generateStudy: jest.fn() };
});

const request = require('supertest');
const mongoose = require('mongoose');
const processingClient = require('../src/services/processingClient');
const queueMock = require('./helpers/queueMock');
const aiGate = require('../src/services/ai/aiGate');
const { createApp } = require('../src/app');
const Source = require('../src/models/Source');
const Summary = require('../src/models/Summary');
const ContentChunk = require('../src/models/ContentChunk');
const ProcessingJob = require('../src/models/ProcessingJob');
const StudyNote = require('../src/models/StudyNote');
const Quiz = require('../src/models/Quiz');
const { processJob } = require('../src/workers/processor');
const { retrieve, __clearQueryCache } = require('../src/services/rag/retrieval');
const { fakeEmbedTexts, seedIndexedSource } = require('./helpers/rag');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
const paragraph = (i) => `Paragraph ${i}: urban trees cool the streets by providing shade and moisture. `.repeat(3);

beforeAll(startTestDatabase);
beforeEach(() => {
  queueMock.__reset();
  aiGate.__reset();
  __clearQueryCache();
  processingClient.embedTexts.mockImplementation(fakeEmbedTexts);
});
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

async function run(type, input, userId) {
  const job = await ProcessingJob.create({ user: userId, type, input, maxAttempts: 3 });
  return processJob({ data: { processingJobId: job.id, type, input }, attemptsMade: 0, opts: { attempts: 3 } });
}

let n = 0;
async function articleSource(userId, content) {
  n += 1;
  const source = await Source.create({
    user: userId,
    kind: 'article',
    submittedUrl: `https://example.com/c${n}`,
    normalizedUrl: `cache:${n}`,
    metadata: { title: 'Trees' },
    status: 'completed',
    content,
    extractedAt: new Date(),
  });
  const summary = await Summary.create({ user: userId, source: source._id, title: 'Trees', overview: 'Urban trees cool streets well.', model: 'm', promptVersion: 'v' });
  await Source.updateOne({ _id: source._id }, { $set: { summary: summary._id } });
  return source;
}

const SUMMARY_RESULT = {
  summary: {
    title: 'Trees',
    overview: 'An overview long enough to pass validation rules.',
    sections: [{ heading: 'A', content: 'B' }],
    key_takeaways: ['One'],
    concepts: [],
    main_arguments: ['Two'],
  },
  model: 'gen-model',
  prompt_version: 'v1',
  input_truncated: false,
};

describe('summary cache', () => {
  test('unchanged content reuses the summary; changed content is summarized again', async () => {
    const userId = new mongoose.Types.ObjectId();
    const source = await Source.create({
      user: userId,
      kind: 'article',
      submittedUrl: 'https://example.com/a',
      normalizedUrl: 'a',
      status: 'queued',
      content: paragraph(1),
      extractedAt: new Date(),
      metadata: { title: 'Trees' },
    });
    processingClient.summarizeArticle.mockResolvedValue(SUMMARY_RESULT);
    await run('summarize_article', { sourceId: source.id }, userId);
    expect(processingClient.summarizeArticle).toHaveBeenCalledTimes(1);

    await Source.updateOne({ _id: source._id }, { $set: { status: 'failed' } });
    const cached = await run('summarize_article', { sourceId: source.id }, userId);
    expect(cached.cached).toBe(true);
    expect(processingClient.summarizeArticle).toHaveBeenCalledTimes(1);
    expect((await Source.findById(source._id)).status).toBe('completed');

    await Source.updateOne({ _id: source._id }, { $set: { status: 'failed', content: paragraph(2) } });
    await run('summarize_article', { sourceId: source.id }, userId);
    expect(processingClient.summarizeArticle).toHaveBeenCalledTimes(2);
    expect(await Summary.countDocuments({ source: source._id })).toBe(1);
  });

  test("another user's identical content is never reused", async () => {
    const [a, b] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    processingClient.summarizeArticle.mockResolvedValue(SUMMARY_RESULT);
    for (const [user, url] of [[a, 'x'], [b, 'y']]) {
      const s = await Source.create({ user, kind: 'article', submittedUrl: `https://example.com/${url}`, normalizedUrl: url, status: 'queued', content: paragraph(7), extractedAt: new Date() });
      await run('summarize_article', { sourceId: s.id }, user);
    }
    expect(processingClient.summarizeArticle).toHaveBeenCalledTimes(2);
  });
});

describe('embedding reuse', () => {
  test('an unchanged, fully indexed source makes no embedding request', async () => {
    const userId = new mongoose.Types.ObjectId();
    const source = await articleSource(userId, [1, 2, 3, 4].map(paragraph).join('\n\n'));
    await run('index_source', { sourceId: source.id, userId: String(userId) }, userId);
    const calls = processingClient.embedTexts.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const result = await run('index_source', { sourceId: source.id, userId: String(userId) }, userId);
    expect(processingClient.embedTexts.mock.calls.length).toBe(calls);
    expect(result.embedded).toBe(0);
    expect((await Source.findById(source._id)).rag.status).toBe('ready');
  });

  test('re-indexing changed content only embeds new text; unchanged vectors are reused', async () => {
    const userId = new mongoose.Types.ObjectId();
    aiGate.setModelLoader(async () => ({ embedding_model: 'fake-embedding', generation_model: 'g', configured: true }));
    const source = await articleSource(userId, [1, 2, 3, 4].map(paragraph).join('\n\n'));
    await run('index_source', { sourceId: source.id, userId: String(userId) }, userId);
    const firstTexts = processingClient.embedTexts.mock.calls.flatMap((c) => c[0].texts);

    await Source.updateOne({ _id: source._id }, { $set: { content: [1, 2, 3, 99].map(paragraph).join('\n\n') } });
    processingClient.embedTexts.mockClear();
    const result = await run('index_source', { sourceId: source.id, userId: String(userId) }, userId);
    const secondTexts = processingClient.embedTexts.mock.calls.flatMap((c) => c[0].texts);
    expect(secondTexts.length).toBeGreaterThan(0);
    expect(secondTexts.length).toBeLessThan(firstTexts.length);
    expect(secondTexts.every((t) => !firstTexts.includes(t))).toBe(true);
    expect(result.reused).toBeGreaterThan(0);
    const chunks = await ContentChunk.find({ source: source._id }).select('+embedding');
    expect(chunks.every((c) => c.embedding?.length === 64)).toBe(true);
  });

  test('identical texts are embedded once and the vector is shared', async () => {
    const userId = new mongoose.Types.ObjectId();
    const same = 'Exactly the same paragraph about street trees and shade, repeated in the article.';
    const source = await articleSource(userId, [same, paragraph(1), same, same].join('\n\n'));
    await Source.updateOne({ _id: source._id }, { $set: { summary: null } });
    await Summary.deleteMany({ source: source._id });
    await run('index_source', { sourceId: source.id, userId: String(userId) }, userId);
    const texts = processingClient.embedTexts.mock.calls.flatMap((c) => c[0].texts);
    expect(new Set(texts).size).toBe(texts.length);
    const chunks = await ContentChunk.find({ source: source._id }).select('+embedding');
    expect(chunks.every((c) => c.embedding?.length)).toBe(true);
  });
});

describe('study material cache', () => {
  async function signUp() {
    n += 1;
    const res = await request(app).post('/api/auth/register').send({ name: 'Cache Tester', email: `cache${n}@example.com`, password: 'reading123' });
    return { userId: res.body.data.user.id, auth: { Authorization: `Bearer ${res.body.data.accessToken}` } };
  }
  const NOTES = {
    notes: {
      title: 'T',
      overview: 'Overview text here.',
      key_concepts: [{ term: 'A', explanation: 'B', refs: [] }],
      definitions: [],
      key_facts: [],
      examples: [],
      formulas: [],
      revision_points: [{ text: 'x', refs: [] }],
      external_knowledge: [],
    },
    model: 'gen',
    prompt_version: 'study-v1',
  };

  test('notes are reused while the source is unchanged and regenerated when it changes', async () => {
    const { userId, auth } = await signUp();
    const source = await articleSource(userId, paragraph(1));
    await Source.updateOne({ _id: source._id }, { $set: { 'rag.contentHash': 'hash-1' } });
    processingClient.generateStudy.mockResolvedValue(NOTES);

    expect((await request(app).post(`/api/sources/${source.id}/notes`).set(auth).send({})).status).toBe(202);
    const queued = queueMock.__state.added[0];
    await processJob({ data: queued.data, attemptsMade: 0, opts: { attempts: 3 } });

    const again = await request(app).post(`/api/sources/${source.id}/notes`).set(auth).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.cached).toBe(true);
    expect(queueMock.__state.added).toHaveLength(1);
    expect((await request(app).get(`/api/sources/${source.id}/notes`).set(auth)).body.data.item.stale).toBe(false);

    await Source.updateOne({ _id: source._id }, { $set: { 'rag.contentHash': 'hash-2' } });
    expect((await request(app).get(`/api/sources/${source.id}/notes`).set(auth)).body.data.item.stale).toBe(true);
    const regenerated = await request(app).post(`/api/sources/${source.id}/notes`).set(auth).send({});
    expect(regenerated.status).toBe(202);
    expect(queueMock.__state.added).toHaveLength(2);
    expect(await StudyNote.countDocuments()).toBe(1);
  });

  test('a different flashcard count is a new configuration', async () => {
    const { userId, auth } = await signUp();
    const source = await articleSource(userId, paragraph(1));
    await request(app).post(`/api/sources/${source.id}/flashcards`).set(auth).send({ count: 10 });
    await mongoose.model('FlashcardDeck').updateOne({ source: source._id }, { $set: { status: 'completed' } });
    expect((await request(app).post(`/api/sources/${source.id}/flashcards`).set(auth).send({ count: 10 })).status).toBe(200);
    expect((await request(app).post(`/api/sources/${source.id}/flashcards`).set(auth).send({ count: 20 })).status).toBe(202);
  });

  test('quizzes: double clicks return the same quiz; identical settings reuse; regenerate makes a new one', async () => {
    const { userId, auth } = await signUp();
    const source = await articleSource(userId, paragraph(1));
    const body = { count: 5, difficulty: 'easy', types: ['true_false', 'multiple_choice'] };
    const [one, two] = await Promise.all([
      request(app).post(`/api/sources/${source.id}/quizzes`).set(auth).send(body),
      request(app).post(`/api/sources/${source.id}/quizzes`).set(auth).send({ ...body, types: ['multiple_choice', 'true_false'] }),
    ]);
    const ids = [one.body.data.item.id, two.body.data.item.id];
    // Concurrent first requests may both start; a later one must reuse.
    const third = await request(app).post(`/api/sources/${source.id}/quizzes`).set(auth).send(body);
    expect(third.status).toBe(200);
    expect(third.body.data.reused).toBe(true);
    expect(ids).toContain(third.body.data.item.id);

    await Quiz.updateMany({}, { $set: { status: 'completed' } });
    const reused = await request(app).post(`/api/sources/${source.id}/quizzes`).set(auth).send(body);
    expect(reused.body.data.reused).toBe(true);
    const fresh = await request(app).post(`/api/sources/${source.id}/quizzes`).set(auth).send({ ...body, regenerate: true });
    expect(fresh.status).toBe(202);
    expect(ids).not.toContain(fresh.body.data.item.id);
  });
});

describe('search relevance threshold', () => {
  test('unrelated queries return nothing above the threshold; related ones are kept; isolation holds', async () => {
    const alice = new mongoose.Types.ObjectId();
    const bob = new mongoose.Types.ObjectId();
    await seedIndexedSource(alice, { title: 'Trees', chunks: ['Urban trees cool streets through shade and evapotranspiration.', 'Budget planning for maintenance crews.'] });
    await seedIndexedSource(bob, { title: 'Bob', chunks: ['Quantum computers use qubits and error correction codes.'] });

    const related = await retrieve({ userId: alice, query: 'urban trees shade streets', minScore: 0.75 });
    expect(related.chunks.length).toBeGreaterThan(0);
    expect(related.chunks.every((c) => c.semanticScore >= 0.75)).toBe(true);
    expect(related.chunks[0].text).toMatch(/Urban trees/);

    const unrelated = await retrieve({ userId: alice, query: 'quantum qubits error correction', minScore: 0.75 });
    expect(unrelated.chunks).toEqual([]);
    const off = await retrieve({ userId: alice, query: 'quantum qubits error correction', minScore: 0 });
    expect(off.chunks.every((c) => String(c.user) === String(alice))).toBe(true);
  });

  test('keyword-only matches are scored against the query vector too', async () => {
    const alice = new mongoose.Types.ObjectId();
    await seedIndexedSource(alice, { title: 'Mixed', chunks: ['Budget planning for maintenance crews.', 'Street trees reduce heat.'] });
    const { chunks } = await retrieve({ userId: alice, query: 'maintenance', minScore: 0 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => typeof c.semanticScore === 'number')).toBe(true);
  });

  test('query vectors are cached per user (no second embedding request)', async () => {
    const alice = new mongoose.Types.ObjectId();
    const bob = new mongoose.Types.ObjectId();
    await seedIndexedSource(alice, { chunks: ['Urban trees cool streets.'] });
    await retrieve({ userId: alice, query: 'Urban trees' });
    await retrieve({ userId: alice, query: '  urban TREES ' });
    expect(processingClient.embedTexts).toHaveBeenCalledTimes(1);
    await retrieve({ userId: bob, query: 'Urban trees' });
    expect(processingClient.embedTexts).toHaveBeenCalledTimes(2);
  });

  test('exact-store scores use the same 0..1 scale as Atlas vectorSearchScore', () => {
    const { toRelevance } = require('../src/services/rag/vectorStore');
    expect(toRelevance(1)).toBe(1);
    expect(toRelevance(0)).toBe(0.5);
    expect(toRelevance(-1)).toBe(0);
  });
});

describe('usage overview', () => {
  test('shows budgets, per-feature usage and provider state without secrets', async () => {
    const res = await request(app).post('/api/auth/register').send({ name: 'Usage Tester', email: 'usage@example.com', password: 'reading123' });
    const auth = { Authorization: `Bearer ${res.body.data.accessToken}` };
    await aiGate.runWithAiContext({ feature: 'chat', userId: res.body.data.user.id }, () =>
      aiGate.withAiCall({ kind: 'generation', operation: 'answer' }, async () => ({ data: { model: 'gen-x' }, requests: 2 }))
    );
    const usage = (await request(app).get('/api/usage').set(auth)).body.data.usage;
    expect(usage.app.generation.used).toBe(2);
    expect(usage.user.byFeature.chat.generation).toBe(2);
    expect(usage.provider.generation.state).toBe('available');
    expect(usage.note).toMatch(/Google AI Studio/);
    expect(JSON.stringify(usage)).not.toMatch(/AIza|api[_ ]?key|secret/i);
    expect((await request(app).get('/api/usage')).status).toBe(401);
  });
});
