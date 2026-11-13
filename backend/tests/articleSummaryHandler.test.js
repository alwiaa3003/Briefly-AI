'use strict';

/**
 * Tests the summarize_article job through the real shared processor, with the
 * processing-service HTTP client mocked (no network, no Gemini).
 */

jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return { ...actual, extractArticle: jest.fn(), summarizeArticle: jest.fn() };
});

const mongoose = require('mongoose');
const { UnrecoverableError } = require('bullmq');
const processingClient = require('../src/services/processingClient');
const { ProcessingServiceError } = processingClient;
const Source = require('../src/models/Source');
const Summary = require('../src/models/Summary');
const ProcessingJob = require('../src/models/ProcessingJob');
const { processJob } = require('../src/workers/processor');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const EXTRACTED = {
  requested_url: 'https://news.example.com/trees',
  final_url: 'https://news.example.com/trees',
  canonical_url: 'https://news.example.com/science/trees',
  title: 'How Urban Trees Cool Cities',
  author: 'Priya Raman',
  published_at: '2025-06-14',
  site_name: 'Example News',
  description: 'Street trees lower temperatures.',
  language: 'en',
  content: 'Trees cool cities.\n\n## Unequal shade\n\nLower-income areas have less canopy.',
  word_count: 320,
  content_truncated: false,
};

const SUMMARIZED = {
  summary: {
    title: 'How Urban Trees Cool Cities',
    overview: 'Dense canopy keeps neighbourhoods cooler, but shade is unevenly shared between districts.',
    sections: [
      { heading: 'How trees cool streets', content: 'Shade and evapotranspiration lower temperatures.' },
      { heading: 'Unequal shade', content: 'Lower-income districts have less canopy.' },
    ],
    key_takeaways: ['Canopy cools streets.', 'Shade is unequal.', 'Young trees take years.', 'Protect mature trees.', 'Funding must last.'],
    concepts: [{ term: 'Evapotranspiration', explanation: 'Water released by leaves, cooling the air.' }],
    main_arguments: ['Urban forests are a cost-effective adaptation tool.'],
  },
  model: 'gemini-test',
  prompt_version: 'article-summary-v1',
  input_truncated: false,
  input_characters: 80,
  usage: { input_tokens: 1000, output_tokens: 300 },
};

beforeAll(startTestDatabase);
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

async function createQueuedArticle(extra = {}) {
  const userId = new mongoose.Types.ObjectId();
  const source = await Source.create({
    user: userId,
    kind: 'article',
    submittedUrl: 'https://news.example.com/trees',
    normalizedUrl: 'https://news.example.com/trees',
    ...extra,
  });
  const job = await ProcessingJob.create({
    user: userId,
    type: 'summarize_article',
    source: source._id,
    input: { sourceId: source.id },
    maxAttempts: 3,
  });
  return { source, job, userId };
}

function bullJob(job, { attemptsMade = 0, attempts = 3 } = {}) {
  return {
    data: { processingJobId: job.id, type: 'summarize_article', input: { sourceId: job.input.sourceId } },
    attemptsMade,
    opts: { attempts },
  };
}

test('extracts, summarizes and persists the article, then completes the job', async () => {
  const { source, job, userId } = await createQueuedArticle();
  processingClient.extractArticle.mockResolvedValue(EXTRACTED);
  processingClient.summarizeArticle.mockResolvedValue(SUMMARIZED);

  const result = await processJob(bullJob(job));

  expect(processingClient.extractArticle).toHaveBeenCalledWith({ url: 'https://news.example.com/trees' });
  expect(processingClient.summarizeArticle).toHaveBeenCalledWith({
    url: 'https://news.example.com/science/trees',
    title: 'How Urban Trees Cool Cities',
    author: 'Priya Raman',
    publishedAt: '2025-06-14',
    siteName: 'Example News',
    content: EXTRACTED.content,
  });

  const updated = await Source.findById(source.id).select('+content');
  expect(updated.status).toBe('completed');
  expect(updated.canonicalUrl).toBe('https://news.example.com/science/trees');
  expect(updated.metadata).toMatchObject({ title: 'How Urban Trees Cool Cities', author: 'Priya Raman', wordCount: 320 });
  expect(updated.content).toBe(EXTRACTED.content);
  expect(updated.completedAt).toBeInstanceOf(Date);

  const summary = await Summary.findById(updated.summary);
  expect(summary.user.toString()).toBe(userId.toString());
  expect(summary.keyTakeaways).toHaveLength(5);
  expect(summary.mainArguments).toEqual(['Urban forests are a cost-effective adaptation tool.']);
  expect(summary.model).toBe('gemini-test');
  expect(summary.usage.toObject()).toEqual({ inputTokens: 1000, outputTokens: 300 });

  const finishedJob = await ProcessingJob.findById(job.id);
  expect(finishedJob.status).toBe('completed');
  // The job result holds references only, not article text or summary content.
  expect(finishedJob.result).toEqual({ sourceId: source.id, summaryId: summary.id });
  expect(result).toEqual({ sourceId: source.id, summaryId: summary.id });
});

test('a retry after a summarization failure does not re-fetch the article', async () => {
  const { source, job } = await createQueuedArticle();
  processingClient.extractArticle.mockResolvedValue(EXTRACTED);
  processingClient.summarizeArticle
    .mockRejectedValueOnce(new ProcessingServiceError('The AI service is busy.', { code: 'AI_RATE_LIMITED', retryable: true }))
    .mockResolvedValueOnce(SUMMARIZED);

  await expect(processJob(bullJob(job, { attemptsMade: 0 }))).rejects.toThrow('busy');
  const between = await Source.findById(source.id);
  expect(between.status).toBe('summarizing');
  expect((await ProcessingJob.findById(job.id)).status).toBe('queued'); // waiting for BullMQ retry

  await processJob(bullJob(job, { attemptsMade: 1 }));

  expect(processingClient.extractArticle).toHaveBeenCalledTimes(1);
  expect(processingClient.summarizeArticle).toHaveBeenCalledTimes(2);
  expect((await Source.findById(source.id)).status).toBe('completed');
  expect(await Summary.countDocuments()).toBe(1);
});

test('a non-retryable extraction error fails the job and the source with a user-safe message', async () => {
  const { source, job } = await createQueuedArticle();
  processingClient.extractArticle.mockRejectedValue(
    new ProcessingServiceError('The website refused access to this page. It may require a login or subscription.', {
      code: 'ARTICLE_ACCESS_DENIED',
      status: 422,
      retryable: false,
    })
  );

  await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);

  const failed = await Source.findById(source.id);
  expect(failed.status).toBe('failed');
  expect(failed.error.toObject()).toEqual({
    code: 'ARTICLE_ACCESS_DENIED',
    message: 'The website refused access to this page. It may require a login or subscription.',
  });
  expect(failed.failedAt).toBeInstanceOf(Date);
  expect(processingClient.summarizeArticle).not.toHaveBeenCalled();
  expect((await ProcessingJob.findById(job.id)).status).toBe('failed');
});

test('retryable errors on the final attempt also mark the source failed', async () => {
  const { source, job } = await createQueuedArticle();
  processingClient.extractArticle.mockRejectedValue(
    new ProcessingServiceError('The website took too long to respond.', { code: 'ARTICLE_TIMEOUT', retryable: true })
  );

  await expect(processJob(bullJob(job, { attemptsMade: 2, attempts: 3 }))).rejects.toThrow();

  const failed = await Source.findById(source.id);
  expect(failed.status).toBe('failed');
  expect(failed.error.code).toBe('ARTICLE_TIMEOUT');
});

test('a malformed summary payload is rejected and nothing is saved', async () => {
  const { source, job } = await createQueuedArticle();
  processingClient.extractArticle.mockResolvedValue(EXTRACTED);
  processingClient.summarizeArticle.mockResolvedValue({ ...SUMMARIZED, summary: { ...SUMMARIZED.summary, sections: 'nope' } });

  await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);

  expect(await Summary.countDocuments()).toBe(0);
  const failed = await Source.findById(source.id);
  expect(failed.status).toBe('failed');
  expect(failed.error.code).toBe('AI_INVALID_RESPONSE');
});

test('a malformed extraction payload is rejected', async () => {
  const { source, job } = await createQueuedArticle();
  processingClient.extractArticle.mockResolvedValue({ ...EXTRACTED, content: '' });

  await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);
  expect((await Source.findById(source.id)).status).toBe('failed');
  expect(processingClient.summarizeArticle).not.toHaveBeenCalled();
});

test('unexpected internal errors are stored with a generic message', async () => {
  const { source, job } = await createQueuedArticle();
  processingClient.extractArticle.mockRejectedValue(new Error('ECONNRESET at internal-host:8000 secret=xyz'));

  await expect(processJob(bullJob(job, { attemptsMade: 2, attempts: 3 }))).rejects.toThrow();

  const failed = await Source.findById(source.id);
  expect(failed.error.toObject()).toEqual({ code: 'JOB_FAILED', message: 'The job failed due to an internal error.' });
});

test('an already completed source is not processed again', async () => {
  const { source, job, userId } = await createQueuedArticle();
  const summary = await Summary.create({
    user: userId,
    source: source._id,
    title: 'Done',
    overview: 'Already summarized article overview text.',
    sections: [{ heading: 'A', content: 'B' }],
    model: 'm',
    promptVersion: 'v1',
  });
  await Source.updateOne({ _id: source._id }, { $set: { status: 'completed', summary: summary._id } });

  const result = await processJob(bullJob(job));

  expect(result).toEqual({ sourceId: source.id, summaryId: summary.id });
  expect(processingClient.extractArticle).not.toHaveBeenCalled();
  expect(processingClient.summarizeArticle).not.toHaveBeenCalled();
});

test('a deleted source fails the job permanently', async () => {
  const { source, job } = await createQueuedArticle();
  await Source.deleteOne({ _id: source._id });

  await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);
  expect((await ProcessingJob.findById(job.id)).status).toBe('failed');
});
