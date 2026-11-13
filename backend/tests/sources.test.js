'use strict';

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));

const request = require('supertest');
const queueMock = require('./helpers/queueMock');
const { createApp } = require('../src/app');
const Source = require('../src/models/Source');
const Summary = require('../src/models/Summary');
const ProcessingJob = require('../src/models/ProcessingJob');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
const ARTICLE = 'https://news.example.com/2025/urban-trees';

let counter = 0;
async function signUp() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Reader Person', email: `reader${counter}@example.com`, password: 'reading123' });
  const token = res.body.data.accessToken;
  return { token, userId: res.body.data.user.id, auth: { Authorization: `Bearer ${token}` } };
}

function submit(auth, url = ARTICLE) {
  return request(app).post('/api/articles').set(auth).send({ url });
}

async function completeSource(sourceId, userId, overrides = {}) {
  const summary = await Summary.create({
    user: userId,
    source: sourceId,
    title: 'How Urban Trees Cool Cities',
    overview: 'Dense canopy keeps neighbourhoods cooler, but shade is unevenly shared.',
    sections: [{ heading: 'Cooling', content: 'Leaves block sunlight.' }],
    keyTakeaways: ['Trees cool streets.', 'Shade is unequal.', 'Young trees take time.'],
    concepts: [{ term: 'Canopy', explanation: 'Tree cover over streets.' }],
    mainArguments: ['Urban forests are cost-effective.'],
    model: 'fake-model',
    promptVersion: 'article-summary-v1',
  });
  await Source.updateOne(
    { _id: sourceId },
    {
      $set: {
        status: 'completed',
        summary: summary._id,
        completedAt: new Date(),
        'metadata.title': 'How Urban Trees Cool Cities',
        'metadata.siteName': 'Example News',
        ...overrides,
      },
    }
  );
  return summary;
}

beforeAll(startTestDatabase);
beforeEach(() => queueMock.__reset());
afterEach(clearTestDatabase);
afterAll(stopTestDatabase);

describe('Authentication on article and source routes', () => {
  test.each([
    ['post', '/api/articles'],
    ['get', '/api/sources'],
    ['get', '/api/sources/stats'],
    ['get', '/api/sources/507f1f77bcf86cd799439011'],
    ['post', '/api/sources/507f1f77bcf86cd799439011/retry'],
  ])('%s %s requires a token', async (method, path) => {
    const res = await request(app)[method](path).send({ url: ARTICLE });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/articles', () => {
  test('creates a source and queues a summarize_article job', async () => {
    const { auth, userId } = await signUp();
    const res = await submit(auth);

    expect(res.status).toBe(202);
    expect(res.body.data.duplicate).toBe(false);
    expect(res.body.data.source).toMatchObject({ kind: 'article', status: 'queued', submittedUrl: ARTICLE });
    expect(res.body.data.source.user).toBeUndefined();
    expect(res.body.data.source.normalizedUrl).toBeUndefined();
    expect(res.body.data.job).toMatchObject({ status: 'queued', attempts: 0, maxAttempts: 3 });

    const source = await Source.findById(res.body.data.source.id);
    expect(source.user.toString()).toBe(userId);
    expect(source.latestJob.toString()).toBe(res.body.data.job.id);

    const job = await ProcessingJob.findById(res.body.data.job.id);
    expect(job.type).toBe('summarize_article');
    expect(job.source.toString()).toBe(source.id);

    // Only ids go into Redis, never article content.
    expect(queueMock.__state.added).toEqual([
      {
        jobId: job.id,
        type: 'summarize_article',
        data: { processingJobId: job.id, type: 'summarize_article', input: { sourceId: source.id } },
      },
    ]);
  });

  test.each([
    ['', 'VALIDATION_ERROR'],
    ['not a url', 'INVALID_URL'],
    ['ftp://example.com/file', 'INVALID_URL'],
    ['http://localhost/', 'UNSAFE_URL'],
    ['http://169.254.169.254/latest/meta-data', 'UNSAFE_URL'],
    ['http://192.168.1.10/admin', 'UNSAFE_URL'],
    ['https://user:secret@example.com/', 'UNSAFE_URL'],
  ])('rejects %p with 400 %s and creates nothing', async (url, code) => {
    const { auth } = await signUp();
    const res = await submit(auth, url);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(await Source.countDocuments()).toBe(0);
    expect(queueMock.__state.added).toHaveLength(0);
  });

  test('rejects a missing url field', async () => {
    const { auth } = await signUp();
    const res = await request(app).post('/api/articles').set(auth).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('duplicate submissions (including URL variants) reuse the existing source', async () => {
    const { auth } = await signUp();
    const first = await submit(auth);
    const second = await submit(auth, 'https://NEWS.example.com/2025/urban-trees/?utm_source=newsletter#top');

    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.source.id).toBe(first.body.data.source.id);
    expect(second.body.data.job).toBeNull();
    expect(await Source.countDocuments()).toBe(1);
    expect(await ProcessingJob.countDocuments()).toBe(1);
    expect(queueMock.__state.added).toHaveLength(1);
  });

  test('different users can summarize the same URL independently', async () => {
    const a = await signUp();
    const b = await signUp();
    const resA = await submit(a.auth);
    const resB = await submit(b.auth);

    expect(resA.status).toBe(202);
    expect(resB.status).toBe(202);
    expect(resA.body.data.source.id).not.toBe(resB.body.data.source.id);
  });

  test('resubmitting a failed URL re-queues the same source', async () => {
    const { auth } = await signUp();
    const first = await submit(auth);
    await Source.updateOne(
      { _id: first.body.data.source.id },
      { $set: { status: 'failed', error: { code: 'ARTICLE_TIMEOUT', message: 'Too slow.' } } }
    );

    const res = await submit(auth);

    expect(res.status).toBe(202);
    expect(res.body.data.source.id).toBe(first.body.data.source.id);
    expect(res.body.data.source.status).toBe('queued');
    expect(res.body.data.source.error).toBeNull();
    expect(queueMock.__state.added).toHaveLength(2);
  });

  test('returns 503 and creates nothing when the queue is unavailable', async () => {
    const { auth } = await signUp();
    queueMock.__state.available = false;

    const res = await submit(auth);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('QUEUE_UNAVAILABLE');
    expect(await Source.countDocuments()).toBe(0);
  });

  test('marks the source failed (retryable) when enqueueing fails mid-way', async () => {
    const { auth } = await signUp();
    queueMock.__state.failAdd = true;

    const res = await submit(auth);

    expect(res.status).toBe(503);
    const source = await Source.findOne();
    expect(source.status).toBe('failed');
    expect(source.error.code).toBe('QUEUE_UNAVAILABLE');
  });
});

describe('GET /api/sources and /api/sources/stats', () => {
  test('lists only the current user’s sources, newest first, with summary overview', async () => {
    const me = await signUp();
    const other = await signUp();
    const a = await submit(me.auth, 'https://news.example.com/first');
    await submit(me.auth, 'https://blog.example.org/second');
    await submit(other.auth, 'https://news.example.com/not-mine');
    await completeSource(a.body.data.source.id, me.userId);

    const res = await request(app).get('/api/sources').set(me.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items.map((item) => item.url)).toEqual([
      'https://blog.example.org/second',
      'https://news.example.com/first',
    ]);
    const completed = res.body.data.items[1];
    expect(completed).toMatchObject({ status: 'completed', title: 'How Urban Trees Cool Cities', siteName: 'Example News' });
    expect(completed.overview).toMatch(/Dense canopy/);
  });

  test('searches titles and URLs (regex characters are escaped)', async () => {
    const me = await signUp();
    const a = await submit(me.auth, 'https://news.example.com/first');
    await submit(me.auth, 'https://blog.example.org/second');
    await completeSource(a.body.data.source.id, me.userId);

    const byTitle = await request(app).get('/api/sources?search=urban%20trees').set(me.auth);
    expect(byTitle.body.data.items).toHaveLength(1);

    const byUrl = await request(app).get('/api/sources?search=blog.example').set(me.auth);
    expect(byUrl.body.data.items).toHaveLength(1);

    const regex = await request(app).get('/api/sources?search=.*').set(me.auth);
    expect(regex.status).toBe(200);
    expect(regex.body.data.items).toHaveLength(0);
  });

  test('filters by status, including the "processing" group', async () => {
    const me = await signUp();
    const a = await submit(me.auth, 'https://news.example.com/first');
    await submit(me.auth, 'https://blog.example.org/second');
    await completeSource(a.body.data.source.id, me.userId);

    const completed = await request(app).get('/api/sources?status=completed').set(me.auth);
    const processing = await request(app).get('/api/sources?status=processing').set(me.auth);

    expect(completed.body.data.items).toHaveLength(1);
    expect(processing.body.data.items).toHaveLength(1);
    expect(processing.body.data.items[0].status).toBe('queued');
  });

  test('paginates', async () => {
    const me = await signUp();
    for (let i = 0; i < 3; i += 1) await submit(me.auth, `https://news.example.com/story-${i}`);

    const res = await request(app).get('/api/sources?limit=2&page=2').set(me.auth);
    expect(res.body.data).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
    expect(res.body.data.items).toHaveLength(1);
  });

  test('validates query parameters', async () => {
    const me = await signUp();
    const res = await request(app).get('/api/sources?status=bogus&limit=999').set(me.auth);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('stats count only the current user’s sources', async () => {
    const me = await signUp();
    const other = await signUp();
    const a = await submit(me.auth, 'https://news.example.com/first');
    const b = await submit(me.auth, 'https://news.example.com/second');
    await submit(me.auth, 'https://news.example.com/third');
    await submit(other.auth, 'https://news.example.com/other');
    await completeSource(a.body.data.source.id, me.userId);
    await Source.updateOne({ _id: b.body.data.source.id }, { $set: { status: 'failed' } });

    const res = await request(app).get('/api/sources/stats').set(me.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.stats).toEqual({ total: 3, completed: 1, processing: 1, failed: 1 });
  });
});

describe('GET /api/sources/:id', () => {
  test('returns metadata, the full summary and job status', async () => {
    const me = await signUp();
    const created = await submit(me.auth);
    await completeSource(created.body.data.source.id, me.userId);

    const res = await request(app).get(`/api/sources/${created.body.data.source.id}`).set(me.auth);

    expect(res.status).toBe(200);
    const { source } = res.body.data;
    expect(source).toMatchObject({ id: created.body.data.source.id, status: 'completed', url: ARTICLE });
    expect(source.summary).toMatchObject({
      title: 'How Urban Trees Cool Cities',
      keyTakeaways: expect.arrayContaining(['Trees cool streets.']),
      concepts: [{ term: 'Canopy', explanation: 'Tree cover over streets.' }],
      mainArguments: ['Urban forests are cost-effective.'],
    });
    expect(source.summary.user).toBeUndefined();
    expect(source.content).toBeUndefined();
    expect(source.job).toMatchObject({ status: 'queued', maxAttempts: 3 });
  });

  test("another user's source is not found (404), not forbidden", async () => {
    const owner = await signUp();
    const intruder = await signUp();
    const created = await submit(owner.auth);

    const res = await request(app).get(`/api/sources/${created.body.data.source.id}`).set(intruder.auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SOURCE_NOT_FOUND');
  });

  test('rejects malformed ids', async () => {
    const me = await signUp();
    const res = await request(app).get('/api/sources/not-an-id').set(me.auth);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sources/:id/retry', () => {
  test('re-queues a failed source', async () => {
    const me = await signUp();
    const created = await submit(me.auth);
    await Source.updateOne({ _id: created.body.data.source.id }, { $set: { status: 'failed' } });

    const res = await request(app).post(`/api/sources/${created.body.data.source.id}/retry`).set(me.auth);

    expect(res.status).toBe(202);
    expect(res.body.data.source.status).toBe('queued');
    expect(res.body.data.job.id).not.toBe(created.body.data.job.id);
    expect(queueMock.__state.added).toHaveLength(2);
  });

  test('refuses to retry a source that has not failed', async () => {
    const me = await signUp();
    const created = await submit(me.auth);

    const res = await request(app).post(`/api/sources/${created.body.data.source.id}/retry`).set(me.auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_RETRYABLE');
    expect(queueMock.__state.added).toHaveLength(1);
  });

  test("cannot retry another user's source", async () => {
    const owner = await signUp();
    const intruder = await signUp();
    const created = await submit(owner.auth);
    await Source.updateOne({ _id: created.body.data.source.id }, { $set: { status: 'failed' } });

    const res = await request(app).post(`/api/sources/${created.body.data.source.id}/retry`).set(intruder.auth);
    expect(res.status).toBe(404);
    expect((await Source.findById(created.body.data.source.id)).status).toBe('failed');
  });

  test('concurrent retries start only one job', async () => {
    const me = await signUp();
    const created = await submit(me.auth);
    await Source.updateOne({ _id: created.body.data.source.id }, { $set: { status: 'failed' } });

    const path = `/api/sources/${created.body.data.source.id}/retry`;
    const results = await Promise.all([request(app).post(path).set(me.auth), request(app).post(path).set(me.auth)]);

    expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(queueMock.__state.added).toHaveLength(2); // original + one retry
  });
});
