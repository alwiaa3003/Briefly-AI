'use strict';

/** index_source through the real processor; embeddings and the queue are mocked. */

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return { ...actual, embedTexts: jest.fn(), extractArticle: jest.fn(), summarizeArticle: jest.fn() };
});

const mongoose = require('mongoose');
const { UnrecoverableError } = require('bullmq');
const processingClient = require('../src/services/processingClient');
const queueMock = require('./helpers/queueMock');
const Source = require('../src/models/Source');
const Summary = require('../src/models/Summary');
const Transcript = require('../src/models/Transcript');
const DocumentPart = require('../src/models/DocumentPart');
const ContentChunk = require('../src/models/ContentChunk');
const ProcessingJob = require('../src/models/ProcessingJob');
const { processJob } = require('../src/workers/processor');
const { scheduleIndexing } = require('../src/services/rag/indexService');
const { fakeEmbedTexts } = require('./helpers/rag');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const userId = new mongoose.Types.ObjectId();
const paragraph = (i) => `Paragraph ${i}: urban trees cool the streets by providing shade and moisture. `.repeat(3);

beforeAll(startTestDatabase);
beforeEach(() => {
  queueMock.__reset();
  processingClient.embedTexts.mockImplementation(fakeEmbedTexts);
});
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

let n = 0;
async function completedSource(kind, extra = {}) {
  n += 1;
  const source = await Source.create({
    user: userId,
    kind,
    submittedUrl: kind === 'article' || kind === 'youtube' ? `https://example.com/${n}` : null,
    normalizedUrl: `k:${n}`,
    metadata: { title: `Source ${n}` },
    status: 'completed',
    ...extra,
  });
  const summary = await Summary.create({
    user: userId,
    source: source._id,
    title: `Source ${n}`,
    overview: 'Urban trees cool cities and the benefit is unevenly shared.',
    keyTakeaways: ['Trees cool streets.'],
    model: 'fake',
    promptVersion: 'v1',
  });
  await Source.updateOne({ _id: source._id }, { $set: { summary: summary._id } });
  return source;
}

async function runIndex(source, { attempt = 1, attempts = 3 } = {}) {
  const job = await ProcessingJob.create({
    user: userId,
    type: 'index_source',
    source: source._id,
    input: { sourceId: source.id, userId: String(userId) },
    maxAttempts: attempts,
  });
  return processJob({
    data: { processingJobId: job.id, type: 'index_source', input: { sourceId: source.id, userId: String(userId) } },
    attemptsMade: attempt - 1,
    opts: { attempts },
  });
}

describe('index_source', () => {
  test('article: chunks + summary chunk are stored and embedded in batches', async () => {
    const source = await completedSource('article', { content: Array.from({ length: 8 }, (_, i) => paragraph(i)).join('\n\n') });
    const result = await runIndex(source);
    const chunks = await ContentChunk.find({ source: source._id }).select('+embedding').sort({ index: 1 });
    expect(result.chunkCount).toBe(chunks.length);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.embedding.length === 64 && String(c.user) === String(userId))).toBe(true);
    expect(chunks[chunks.length - 1].chunkType).toBe('summary');
    // RAG_EMBED_BATCH_SIZE=4 in tests
    expect(processingClient.embedTexts.mock.calls.length).toBe(Math.ceil(chunks.length / 4));
    expect(processingClient.embedTexts.mock.calls[0][0].task).toBe('document');

    const updated = await Source.findById(source._id);
    expect(updated.rag).toMatchObject({ status: 'ready', chunkCount: chunks.length, embeddedCount: chunks.length, model: 'fake-embedding', dimensions: 64 });
  });

  test('video: transcript chunks keep timestamps', async () => {
    const source = await completedSource('youtube');
    await Transcript.create({
      user: userId,
      source: source._id,
      origin: 'youtube_video',
      segments: Array.from({ length: 20 }, (_, i) => ({ start: i * 20, end: i * 20 + 19, text: paragraph(i).slice(0, 90) })),
    });
    await runIndex(source);
    const first = await ContentChunk.findOne({ source: source._id, index: 0 });
    expect(first.startSeconds).toBe(0);
    expect(first.label).toMatch(/^0:00–/);
  });

  test('document: chunks keep pages', async () => {
    const source = await completedSource('document', { document: { format: 'pdf' } });
    await DocumentPart.insertMany(
      [1, 2].map((page) => ({ user: userId, source: source._id, index: page - 1, page, blocks: [{ kind: 'paragraph', text: paragraph(page) }] }))
    );
    await runIndex(source);
    const pages = (await ContentChunk.find({ source: source._id, chunkType: 'content' })).map((c) => c.page);
    expect(new Set(pages)).toEqual(new Set([1, 2]));
  });

  test('a retry keeps chunks and only embeds the missing ones', async () => {
    const source = await completedSource('article', { content: Array.from({ length: 6 }, (_, i) => paragraph(i)).join('\n\n') });
    processingClient.embedTexts
      .mockImplementationOnce(fakeEmbedTexts)
      .mockRejectedValueOnce(new processingClient.ProcessingServiceError('busy', { code: 'AI_RATE_LIMITED', retryable: true }));
    await expect(runIndex(source)).rejects.toThrow('busy');
    expect((await Source.findById(source._id)).rag.status).toBe('indexing');
    const total = await ContentChunk.countDocuments({ source: source._id });
    expect(await ContentChunk.countDocuments({ source: source._id, embedding: { $exists: true } })).toBe(4);

    processingClient.embedTexts.mockImplementation(fakeEmbedTexts);
    await runIndex(source, { attempt: 2 });
    const embeddedTexts = processingClient.embedTexts.mock.calls.slice(2).flatMap((c) => c[0].texts);
    expect(embeddedTexts.length).toBe(total - 4);
    expect((await Source.findById(source._id)).rag).toMatchObject({ status: 'ready', embeddedCount: total });
  });

  test('wrong vector size fails permanently and marks the index failed', async () => {
    const source = await completedSource('article', { content: paragraph(1) });
    processingClient.embedTexts.mockResolvedValue({ vectors: [[1, 0]], model: 'x', dimensions: 2, provider: 'x' });
    await expect(runIndex(source)).rejects.toBeInstanceOf(UnrecoverableError);
    const rag = (await Source.findById(source._id)).rag;
    expect(rag.status).toBe('failed');
    expect(rag.error.code).toBe('EMBEDDING_INVALID_RESPONSE');
  });

  test('sources that are not completed are not indexed', async () => {
    const source = await completedSource('article', { content: paragraph(1) });
    await Source.updateOne({ _id: source._id }, { $set: { status: 'summarizing' } });
    await expect(runIndex(source)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await ContentChunk.countDocuments()).toBe(0);
  });
});

describe('scheduling', () => {
  test('a completed summary job queues indexing automatically', async () => {
    const source = await Source.create({
      user: userId,
      kind: 'article',
      submittedUrl: 'https://example.com/auto',
      normalizedUrl: 'auto',
      status: 'queued',
    });
    processingClient.extractArticle.mockResolvedValue({
      final_url: 'https://example.com/auto',
      canonical_url: 'https://example.com/auto',
      title: 'Auto',
      author: null,
      published_at: null,
      site_name: null,
      description: null,
      language: 'en',
      word_count: 300,
      content: paragraph(1).repeat(5),
      content_truncated: false,
    });
    processingClient.summarizeArticle.mockResolvedValue({
      summary: {
        title: 'Auto',
        overview: 'An overview long enough to pass validation rules.',
        sections: [{ heading: 'A', content: 'B' }],
        key_takeaways: ['One'],
        concepts: [],
        main_arguments: ['Two'],
      },
      model: 'fake',
      prompt_version: 'v1',
      input_truncated: false,
    });
    const job = await ProcessingJob.create({ user: userId, type: 'summarize_article', source: source._id, input: { sourceId: source.id }, maxAttempts: 3 });
    await processJob({ data: { processingJobId: job.id, type: 'summarize_article', input: { sourceId: source.id } }, attemptsMade: 0, opts: { attempts: 3 } });

    expect(queueMock.__state.added.map((j) => j.type)).toEqual(['index_source']);
    expect((await Source.findById(source._id)).rag.status).toBe('queued');
  });

  test('scheduleIndexing skips sources already queued and other users’ sources', async () => {
    const source = await completedSource('article', { content: paragraph(1) });
    expect(await scheduleIndexing({ sourceId: source._id, userId })).not.toBeNull();
    expect(await scheduleIndexing({ sourceId: source._id, userId })).toBeNull();
    expect(await scheduleIndexing({ sourceId: source._id, userId: new mongoose.Types.ObjectId(), force: true })).toBeNull();
    expect(queueMock.__state.added).toHaveLength(1);
  });
});
