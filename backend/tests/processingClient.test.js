'use strict';

/** The processing-service client classifies remote errors and only passes through user-safe messages. */

const { extractArticle, summarizeArticle, ProcessingServiceError } = require('../src/services/processingClient');

const aiGate = require('../src/services/ai/aiGate');

const realFetch = global.fetch;

function respond(status, body) {
  global.fetch = jest.fn(async () => ({ ok: status < 400, status, json: async () => body }));
}

afterEach(() => {
  global.fetch = realFetch;
  aiGate.__reset();
});

test('sends the internal token and returns data on success', async () => {
  respond(200, { success: true, data: { title: 'T' } });

  await expect(extractArticle({ url: 'https://example.com/a' })).resolves.toEqual({ title: 'T' });

  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('http://127.0.0.1:1/internal/articles/extract');
  expect(options.headers['X-Internal-Token']).toBe(process.env.INTERNAL_SERVICE_SECRET);
  expect(JSON.parse(options.body)).toEqual({ url: 'https://example.com/a' });
});

test('maps summarize arguments to the Python field names', async () => {
  respond(200, { success: true, data: {} });
  await summarizeArticle({ url: 'u', title: 'T', author: null, publishedAt: '2025-01-01', siteName: 'S', content: 'C' });
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
    url: 'u',
    title: 'T',
    author: null,
    published_at: '2025-01-01',
    site_name: 'S',
    content: 'C',
  });
});

test('passes through user-facing article/AI errors with the remote retryable flag', async () => {
  respond(422, { success: false, error: { code: 'ARTICLE_NOT_FOUND', message: 'The page could not be found.', retryable: false } });

  const error = await extractArticle({ url: 'https://example.com/a' }).catch((e) => e);

  expect(error).toBeInstanceOf(ProcessingServiceError);
  expect(error).toMatchObject({ code: 'ARTICLE_NOT_FOUND', message: 'The page could not be found.', retryable: false, status: 422 });
});

test('honours retryable=true even on 4xx-style codes', async () => {
  respond(503, { success: false, error: { code: 'AI_RATE_LIMITED', message: 'Busy.', retryable: true } });
  const error = await summarizeArticle({ url: 'u', content: 'c' }).catch((e) => e);
  expect(error.retryable).toBe(true);
});

test('hides messages of internal error codes', async () => {
  respond(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'A valid internal service token is required.', retryable: false } });

  const error = await extractArticle({ url: 'https://example.com/a' }).catch((e) => e);

  expect(error.code).toBe('PROCESSING_UNAUTHORIZED');
  expect(error.message).toBe('The processing service could not complete the request.');
  expect(error.retryable).toBe(false);
});

test('network failures are retryable', async () => {
  global.fetch = jest.fn(async () => {
    throw new TypeError('fetch failed');
  });
  const error = await extractArticle({ url: 'https://example.com/a' }).catch((e) => e);
  expect(error).toMatchObject({ code: 'PROCESSING_SERVICE_UNREACHABLE', retryable: true });
});

describe('Milestone 5 AI calls', () => {
  const { embedTexts, answerQuestion, generateStudy } = require('../src/services/processingClient');

  test('embedTexts posts texts and task', async () => {
    respond(200, { success: true, data: { vectors: [[1]] } });
    await embedTexts({ texts: ['a'], task: 'query' });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:1/internal/ai/embeddings');
    expect(JSON.parse(options.body)).toEqual({ texts: ['a'], task: 'query' });
  });

  test('answerQuestion sends only chunk text and metadata in Python field names', async () => {
    respond(200, { success: true, data: {} });
    await answerQuestion({
      question: 'Q?',
      history: [{ role: 'user', content: 'Hi', extra: 'dropped' }],
      chunks: [{ id: 'c1', text: 'T', label: 'p. 1', sourceId: 'abc', sourceTitle: 'Title', sourceKind: 'document', embedding: [1] }],
      scope: 'source',
      scopeTitle: 'Title',
    });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
      question: 'Q?',
      history: [{ role: 'user', content: 'Hi' }],
      chunks: [{ id: 'c1', text: 'T', label: 'p. 1', source_id: 'abc', source_title: 'Title', source_kind: 'document' }],
      scope: 'source',
      scope_title: 'Title',
    });
  });

  test('generateStudy routes each tool and merges options', async () => {
    respond(200, { success: true, data: {} });
    await generateStudy('quiz', { title: 'T', sourceKind: 'article', chunks: [], options: { count: 5 } });
    await generateStudy('style', { title: 'T', sourceKind: 'article', chunks: [], options: { style: 'concise' } });
    expect(global.fetch.mock.calls.map((c) => c[0])).toEqual([
      'http://127.0.0.1:1/internal/ai/study/quiz',
      'http://127.0.0.1:1/internal/ai/summaries/restyle',
    ]);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ count: 5, source_kind: 'article', summary_overview: null });
  });

  test('embedding errors are user-facing', async () => {
    respond(502, { success: false, error: { code: 'EMBEDDING_INVALID_RESPONSE', message: 'Bad vectors.', retryable: true } });
    const error = await embedTexts({ texts: ['a'], task: 'document' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'EMBEDDING_INVALID_RESPONSE', message: 'Bad vectors.', retryable: true });
  });
});
