'use strict';

/**
 * Retrieval security and behaviour: ownership is enforced by every store and
 * by hybrid retrieval, filters work, and the Atlas pipeline always pre-filters
 * and re-checks the owner.
 */

jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return { ...actual, embedTexts: jest.fn() };
});

const mongoose = require('mongoose');
const processingClient = require('../src/services/processingClient');
const vectorStore = require('../src/services/rag/vectorStore');
const { retrieve, fuse } = require('../src/services/rag/retrieval');
const { fakeVector, fakeEmbedTexts, seedIndexedSource } = require('./helpers/rag');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const alice = new mongoose.Types.ObjectId();
const bob = new mongoose.Types.ObjectId();

beforeAll(startTestDatabase);
beforeEach(() => processingClient.embedTexts.mockImplementation(fakeEmbedTexts));
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

async function seedBoth() {
  const a = await seedIndexedSource(alice, {
    title: 'Alice trees',
    chunks: ['Urban trees cool streets through shade and evapotranspiration.', 'Budget planning for maintenance crews.'],
  });
  const b = await seedIndexedSource(bob, {
    title: 'Bob trees',
    chunks: ['Urban trees cool streets through shade and evapotranspiration. SECRET bob data.'],
  });
  return { a, b };
}

describe('vectorStore', () => {
  test('refuses to search without a user', () => {
    expect(() => vectorStore.buildFilter({})).toThrow(/userId is required/);
  });

  test('exact search returns only the caller’s chunks, ranked by similarity', async () => {
    await seedBoth();
    const rows = await vectorStore.search({ userId: alice, queryVector: fakeVector('urban trees shade'), limit: 10 });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => String(r.user) === String(alice))).toBe(true);
    expect(rows[0].text).toMatch(/Urban trees/);
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    expect(rows[0].embedding).toBeUndefined();
  });

  test('source / kind / date filters narrow the search', async () => {
    const { a } = await seedBoth();
    const other = await seedIndexedSource(alice, { kind: 'document', title: 'Doc', chunks: ['Urban trees in documents.'] });
    const bySource = await vectorStore.search({ userId: alice, queryVector: fakeVector('urban trees'), sourceIds: [other._id] });
    expect(bySource.every((r) => String(r.source) === String(other._id))).toBe(true);
    const byKind = await vectorStore.search({ userId: alice, queryVector: fakeVector('urban trees'), kinds: ['article'] });
    expect(byKind.every((r) => String(r.source) === String(a._id))).toBe(true);
    const future = await vectorStore.search({ userId: alice, queryVector: fakeVector('trees'), from: new Date(Date.now() + 864e5) });
    expect(future).toEqual([]);
  });

  test('atlas pipeline pre-filters by user inside $vectorSearch and re-checks with $match', async () => {
    process.env.VECTOR_STORE = 'atlas';
    try {
      await jest.isolateModulesAsync(async () => {
        const IsolatedChunk = require('../src/models/ContentChunk');
        const spy = jest.spyOn(IsolatedChunk, 'aggregate').mockResolvedValue([
          { _id: 1, user: alice, text: 'mine', score: 0.9 },
          { _id: 2, user: bob, text: 'not mine', score: 0.8 },
        ]);
        const isolatedStore = require('../src/services/rag/vectorStore');
        const rows = await isolatedStore.search({ userId: alice, queryVector: fakeVector('trees'), kinds: ['article'], limit: 4 });

        const [pipeline] = spy.mock.calls[0];
        expect(String(pipeline[0].$vectorSearch.filter.user)).toBe(String(alice));
        expect(pipeline[0].$vectorSearch.filter.kind).toEqual({ $in: ['article'] });
        expect(pipeline[0].$vectorSearch.limit).toBe(4);
        expect(String(pipeline[1].$match.user)).toBe(String(alice));
        expect(pipeline[2]).toEqual({ $project: { embedding: 0 } });
        // Even if the index returned a foreign row, it is dropped.
        expect(rows.map((r) => r.text)).toEqual(['mine']);
        expect(rows[0].store).toBe('atlas');
      });
    } finally {
      delete process.env.VECTOR_STORE;
    }
  });

  test('auto mode falls back to the exact store when Atlas search is unavailable', async () => {
    vectorStore.resetVectorStoreStatus();
    expect(await vectorStore.isAtlasUsable({ force: true })).toBe(false);
  });
});

describe('retrieve (hybrid)', () => {
  test('merges semantic and keyword results and never crosses users', async () => {
    await seedBoth();
    const { chunks, mode } = await retrieve({ userId: alice, query: 'urban trees SECRET', limit: 5 });
    expect(mode).toBe('hybrid');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => String(c.user) === String(alice))).toBe(true);
    expect(chunks.some((c) => /SECRET/.test(c.text))).toBe(false);
    expect(processingClient.embedTexts).toHaveBeenCalledWith({ texts: ['urban trees SECRET'], task: 'query' });
  });

  test('a source-scoped retrieval with another user’s source id returns nothing', async () => {
    const { b } = await seedBoth();
    const { chunks } = await retrieve({ userId: alice, query: 'urban trees', sourceIds: [b._id] });
    expect(chunks).toEqual([]);
  });

  test('degrades to keyword search when embeddings are unavailable', async () => {
    await seedBoth();
    processingClient.embedTexts.mockRejectedValue(
      new processingClient.ProcessingServiceError('not configured', { code: 'AI_NOT_CONFIGURED', retryable: false })
    );
    const { chunks, mode, degradedReason } = await retrieve({ userId: alice, query: 'maintenance budget' });
    expect(mode).toBe('keyword');
    expect(degradedReason).toBe('AI_NOT_CONFIGURED');
    expect(chunks[0].text).toMatch(/Budget planning/);
  });

  test('rejects query vectors of the wrong size (falls back to keyword)', async () => {
    await seedBoth();
    processingClient.embedTexts.mockResolvedValue({ vectors: [[1, 0, 0]], model: 'x', dimensions: 3, provider: 'x' });
    const { mode } = await retrieve({ userId: alice, query: 'trees' });
    expect(mode).toBe('keyword');
  });

  test('fuse ranks items found by both lanes first', () => {
    const a = { _id: 'a', store: 'exact', score: 0.9 };
    const b = { _id: 'b', store: 'exact', score: 0.8 };
    const merged = fuse([[a, b], [{ _id: 'b' }]], 5);
    expect(merged.map((m) => m._id)).toEqual(['b', 'a']);
    expect(merged[0]).toMatchObject({ keywordMatch: true, semanticScore: 0.8 });
  });
});
