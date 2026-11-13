'use strict';

/**
 * Rate-limit handling end to end: delayed job retries (no worker occupied), bounded deferrals,
 * permanent errors, request accounting, Ask AI under quota exhaustion, duplicate submissions,
 * and saved content staying available while Gemini is unavailable.
 */

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return { ...actual, embedTexts: jest.fn(), answerQuestion: jest.fn(), generateStudy: jest.fn() };
});

const request = require('supertest');
const { DelayedError, UnrecoverableError } = require('bullmq');
const mongoose = require('mongoose');
const processingClient = require('../src/services/processingClient');
const { ProcessingServiceError } = processingClient;
const aiGate = require('../src/services/ai/aiGate');
const queueMock = require('./helpers/queueMock');
const { createApp } = require('../src/app');
const config = require('../src/config/env');
const ProcessingJob = require('../src/models/ProcessingJob');
const Source = require('../src/models/Source');
const StudyNote = require('../src/models/StudyNote');
const Message = require('../src/models/Message');
const { processJob, backoffStrategy } = require('../src/workers/processor');
const { fakeEmbedTexts, seedIndexedSource } = require('./helpers/rag');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
let counter = 0;
async function signUp() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Quota Tester', email: `quota${counter}@example.com`, password: 'reading123' });
  return { userId: res.body.data.user.id, auth: { Authorization: `Bearer ${res.body.data.accessToken}` } };
}

const quotaError = (retry = 28853) =>
  new ProcessingServiceError("The AI service's daily quota for this model is used up.", {
    code: 'AI_QUOTA_EXHAUSTED',
    retryable: true,
    meta: { scope: 'daily', retry_after_seconds: retry, model: 'gen-model' },
    geminiRequests: 1,
  });

/** A BullMQ-like job whose moveToDelayed / updateData calls are recorded. */
function fakeJob(record, data = {}) {
  const job = {
    data: { processingJobId: record.id, type: record.type, input: record.input, ...data },
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateData: jest.fn(async (d) => {
      job.data = d;
    }),
    moveToDelayed: jest.fn(async () => {}),
  };
  return job;
}

beforeAll(startTestDatabase);
beforeEach(() => {
  queueMock.__reset();
  aiGate.__reset();
  processingClient.embedTexts.mockImplementation(fakeEmbedTexts);
});
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

/** A completed article source with stored text (what the study handler reads). */
async function studySource(userId) {
  const source = await seedIndexedSource(userId, { title: 'Report', chunks: ['Trees cool streets by two degrees.'] });
  await Source.updateOne(
    { _id: source._id },
    { $set: { content: 'Urban trees cool streets by two degrees through shade and evapotranspiration. '.repeat(4) } }
  );
  return source;
}

async function notesJob(userId, sourceId) {
  const note = await StudyNote.create({ user: userId, source: sourceId, status: 'queued' });
  const record = await ProcessingJob.create({
    user: userId,
    type: 'generate_study_notes',
    source: sourceId,
    input: { targetId: note.id, userId: String(userId) },
    maxAttempts: 3,
  });
  return { note, record };
}

describe('delayed retries for quota and rate limits', () => {
  test('daily quota exhaustion moves the job to the delayed set (bounded), records why, and frees the worker', async () => {
    const userId = new mongoose.Types.ObjectId();
    const source = await studySource(userId);
    const { note, record } = await notesJob(userId, source._id);
    processingClient.generateStudy.mockRejectedValue(quotaError());
    const job = fakeJob(record);

    const before = Date.now();
    await expect(processJob(job, 'lock-token')).rejects.toBeInstanceOf(DelayedError);

    const [until, token] = job.moveToDelayed.mock.calls[0];
    expect(token).toBe('lock-token');
    // Provider asked for ~8 h; one delay is capped at AI_MAX_DELAY_SECONDS (6 h by default).
    expect(until - before).toBeGreaterThan(config.ai.maxDelaySeconds * 1000 - 60000);
    expect(until - before).toBeLessThanOrEqual(config.ai.maxDelaySeconds * 1000 + 1000);
    expect(job.data.aiDeferrals).toBe(1);

    const saved = await ProcessingJob.findById(record.id);
    expect(saved.status).toBe('queued');
    expect(saved.attempts).toBe(1);
    expect(saved.nextAttemptAt).toBeInstanceOf(Date);
    expect(saved.error.message).toMatch(/study notes is paused/);
    expect(saved.error.message).not.toMatch(/summary/);

    const visible = await StudyNote.findById(note.id);
    expect(visible.status).toBe('queued');
    expect(visible.error.code).toBe('AI_QUOTA_EXHAUSTED');
  });

  test('a short provider delay is honoured (not 2 s / 4 s)', async () => {
    const userId = new mongoose.Types.ObjectId();
    const source = await studySource(userId);
    const { record } = await notesJob(userId, source._id);
    processingClient.generateStudy.mockRejectedValue(
      new ProcessingServiceError('busy', { code: 'AI_RATE_LIMITED', retryable: true, meta: { scope: 'minute', retry_after_seconds: 42 } })
    );
    const job = fakeJob(record);
    const before = Date.now();
    await expect(processJob(job, 't')).rejects.toBeInstanceOf(DelayedError);
    const delay = job.moveToDelayed.mock.calls[0][0] - before;
    expect(delay).toBeGreaterThanOrEqual(42000);
    expect(delay).toBeLessThan(42000 + 6000);
  });

  test('while Gemini is blocked, woken jobs re-defer without spending a request', async () => {
    const userId = new mongoose.Types.ObjectId();
    const source = await studySource(userId);
    // A real (gated) call records the provider block.
    await aiGate.withAiCall({ kind: 'generation', operation: 'notes' }, async () => Promise.reject(quotaError(600))).catch(() => null);

    const second = await notesJob(userId, source._id);
    processingClient.generateStudy.mockImplementation((tool, args) =>
      aiGate.withAiCall({ kind: 'generation', operation: tool }, async () => {
        throw new Error(`Gemini must not be called (${args.title})`);
      })
    );
    const job = fakeJob(second.record);
    await expect(processJob(job, 't')).rejects.toBeInstanceOf(DelayedError);
    expect((await ProcessingJob.findById(second.record.id)).error.code).toBe('AI_QUOTA_EXHAUSTED');
  });

  test('deferrals are bounded: after the limit the job fails clearly and can be retried later', async () => {
    const userId = new mongoose.Types.ObjectId();
    const source = await studySource(userId);
    const { note, record } = await notesJob(userId, source._id);
    processingClient.generateStudy.mockRejectedValue(quotaError());
    const job = fakeJob(record, { aiDeferrals: config.ai.maxDeferrals });
    await expect(processJob(job, 't')).rejects.toBeInstanceOf(UnrecoverableError);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    const failed = await StudyNote.findById(note.id);
    expect(failed.status).toBe('failed');
    expect(failed.error.message).toMatch(/could not be generated because Gemini stayed unavailable/);
  });

  test.each([
    ['AI_CONFIGURATION_ERROR', 'invalid API key'],
    ['AI_MODEL_UNAVAILABLE', 'unsupported model'],
    ['AI_REQUEST_REJECTED', 'malformed request'],
  ])('%s (%s) is not retried or deferred', async (code) => {
    const userId = new mongoose.Types.ObjectId();
    const source = await studySource(userId);
    const { note, record } = await notesJob(userId, source._id);
    processingClient.generateStudy.mockRejectedValue(new ProcessingServiceError('nope', { code, retryable: false }));
    const job = fakeJob(record);
    await expect(processJob(job, 't')).rejects.toBeInstanceOf(UnrecoverableError);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect((await StudyNote.findById(note.id)).status).toBe('failed');
  });

  test('transient AI errors back off much longer than generic failures', () => {
    const ai = backoffStrategy(1, 'custom', { code: 'AI_UNAVAILABLE' });
    expect(ai).toBe(config.ai.transientRetrySeconds * 1000);
    expect(backoffStrategy(2, 'custom', { code: 'AI_TIMEOUT' })).toBe(ai * 2);
    expect(backoffStrategy(1, 'custom', new Error('x'))).toBe(config.queue.backoffMs);
  });
});

describe('request accounting through the real client', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('X-Gemini-Requests is counted, and a 429 stops the next call before it is sent', async () => {
    const actual = jest.requireActual('../src/services/processingClient');
    const responses = [
      { status: 200, headers: { 'x-gemini-requests': '2' }, body: { success: true, data: { answer: {}, model: 'gen-model', usage: { input_tokens: 5 } } } },
      {
        status: 429,
        headers: { 'x-gemini-requests': '1' },
        body: { success: false, error: { code: 'AI_RATE_LIMITED', message: 'limited', retryable: true, meta: { scope: 'minute', retry_after_seconds: 30, model: 'gen-model' } } },
      },
    ];
    global.fetch = jest.fn(async (url) => {
      if (String(url).endsWith('/internal/ai/config')) return { ok: false, status: 503, headers: new Map(), json: async () => ({}) };
      const next = responses.shift();
      return { ok: next.status < 400, status: next.status, headers: new Map(Object.entries(next.headers)), json: async () => next.body };
    });
    const args = { question: 'q', history: [], chunks: [], scope: 'library' };
    await aiGate.runWithAiContext({ feature: 'chat', userId: 'u1' }, () => actual.answerQuestion(args));
    const error = await aiGate.runWithAiContext({ feature: 'chat', userId: 'u1' }, () => actual.answerQuestion(args)).catch((e) => e);
    expect(error).toMatchObject({ code: 'AI_RATE_LIMITED', quotaScope: 'minute', retryAfterSeconds: 30, geminiRequests: 1 });
    const blocked = await actual.answerQuestion(args).catch((e) => e);
    expect(blocked).toMatchObject({ name: 'AiGateError', code: 'AI_RATE_LIMITED' });
    const answerCalls = global.fetch.mock.calls.filter(([url]) => String(url).endsWith('/internal/ai/answer'));
    expect(answerCalls).toHaveLength(2);
    const usage = await aiGate.getUsageOverview('u1');
    expect(usage.app.generation.used).toBe(3);
    expect(usage.user.byFeature.chat.generation).toBe(3);
  });
});

describe('Ask AI under limits', () => {
  async function chatSetup() {
    const user = await signUp();
    const source = await seedIndexedSource(user.userId, { title: 'Heat report', chunks: ['Urban trees cool streets through shade.'] });
    const conv = await request(app).post('/api/conversations').set(user.auth).send({ scope: 'source', sourceId: source.id });
    return { ...user, source, conversationId: conv.body.data.conversation.id };
  }
  const answer = { answer: { answer: 'Shade.', support: 'supported', citations: ['c1'], follow_up_questions: [] }, model: 'gen-model' };

  test('quota exhaustion: clear message, Retry-After, no embedding request, question not stored', async () => {
    const { auth, conversationId } = await chatSetup();
    await aiGate.withAiCall({ kind: 'generation', operation: 'answer' }, async () => Promise.reject(quotaError(3600))).catch(() => null);
    const res = await request(app).post(`/api/conversations/${conversationId}/messages`).set(auth).send({ content: 'How do trees cool streets?' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('AI_QUOTA_EXHAUSTED');
    expect(res.body.error.message).toMatch(/Ask AI can’t answer right now: the free Gemini quota is used up/);
    expect(res.body.error.message).toMatch(/saved summaries, notes and conversations are still available/);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(3500);
    expect(processingClient.embedTexts).not.toHaveBeenCalled();
    expect(processingClient.answerQuestion).not.toHaveBeenCalled();
    expect(await Message.countDocuments()).toBe(0);
  });

  test('Briefly budget exhausted: 429 with a budget message', async () => {
    const { auth, conversationId } = await chatSetup();
    processingClient.answerQuestion.mockRejectedValue(
      new aiGate.AiGateError('AI_BUDGET_EXHAUSTED', 'budget', { retryAfterMs: 3 * 3600 * 1000, scope: 'user_daily' })
    );
    const res = await request(app).post(`/api/conversations/${conversationId}/messages`).set(auth).send({ content: 'Why?' });
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/Briefly’s daily AI limit has been reached. It resets in about 3 hours/);
  });

  test('double submission: a second question while one is answered gets 409 and no AI call', async () => {
    const { auth, conversationId } = await chatSetup();
    let finish;
    processingClient.answerQuestion.mockImplementation(() => new Promise((r) => (finish = () => r(answer))));
    const first = request(app).post(`/api/conversations/${conversationId}/messages`).set(auth).send({ content: 'Why shade?' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 300));
    const second = await request(app).post(`/api/conversations/${conversationId}/messages`).set(auth).send({ content: 'Why shade?' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ANSWER_IN_PROGRESS');
    finish();
    expect((await first).status).toBe(201);
    expect(processingClient.answerQuestion).toHaveBeenCalledTimes(1);
  });

  test('re-sending the same clientRequestId returns the stored answer without another AI call', async () => {
    const { auth, conversationId } = await chatSetup();
    processingClient.answerQuestion.mockResolvedValue(answer);
    const body = { content: 'Why shade?', clientRequestId: 'req-1234567890' };
    const one = await request(app).post(`/api/conversations/${conversationId}/messages`).set(auth).send(body);
    const two = await request(app).post(`/api/conversations/${conversationId}/messages`).set(auth).send(body);
    expect(one.status).toBe(201);
    expect(two.status).toBe(200);
    expect(two.body.data.duplicate).toBe(true);
    expect(two.body.data.messages.map((m) => m.id)).toEqual(one.body.data.messages.map((m) => m.id));
    expect(processingClient.answerQuestion).toHaveBeenCalledTimes(1);
    expect(await Message.countDocuments()).toBe(2);
    expect(JSON.stringify(one.body)).not.toMatch(/clientRequestId/);
  });

  test("another user's clientRequestId never returns someone else's answer", async () => {
    const owner = await chatSetup();
    processingClient.answerQuestion.mockResolvedValue(answer);
    await request(app)
      .post(`/api/conversations/${owner.conversationId}/messages`)
      .set(owner.auth)
      .send({ content: 'Why?', clientRequestId: 'shared-id-123456' });
    const other = await signUp();
    const res = await request(app)
      .post(`/api/conversations/${owner.conversationId}/messages`)
      .set(other.auth)
      .send({ content: 'Why?', clientRequestId: 'shared-id-123456' });
    expect(res.status).toBe(404);
  });
});

describe('saved content during quota exhaustion', () => {
  test('library, summaries, notes, conversations and keyword search keep working', async () => {
    const user = await signUp();
    const source = await seedIndexedSource(user.userId, { title: 'Heat report', chunks: ['Urban trees cool streets through shade and evapotranspiration.'] });
    await StudyNote.create({
      user: user.userId,
      source: source._id,
      status: 'completed',
      title: 'Notes',
      overview: 'Trees cool cities.',
      keyConcepts: [{ term: 'Canopy', explanation: 'Tree cover.' }],
      revisionPoints: [{ text: 'Shade.' }, { text: 'Water.' }, { text: 'Cooling.' }],
    });
    // Both generation and embeddings are exhausted.
    await aiGate.withAiCall({ kind: 'generation', operation: 'answer' }, async () => Promise.reject(quotaError(3600))).catch(() => null);
    await aiGate
      .withAiCall({ kind: 'embedding', operation: 'embed' }, async () =>
        Promise.reject(new ProcessingServiceError('x', { code: 'AI_QUOTA_EXHAUSTED', retryable: true, meta: { scope: 'daily', retry_after_seconds: 3600 } }))
      )
      .catch(() => null);
    processingClient.embedTexts.mockImplementation(() => aiGate.withAiCall({ kind: 'embedding', operation: 'embed' }, async () => ({ data: {}, requests: 1 })));

    expect((await request(app).get('/api/sources').set(user.auth)).status).toBe(200);
    expect((await request(app).get(`/api/sources/${source.id}`).set(user.auth)).body.data.source.summary.title).toBe('Heat report');
    expect((await request(app).get(`/api/sources/${source.id}/notes`).set(user.auth)).body.data.item.title).toBe('Notes');
    expect((await request(app).get('/api/conversations').set(user.auth)).status).toBe(200);
    const search = await request(app).get('/api/search').query({ q: 'evapotranspiration' }).set(user.auth);
    expect(search.status).toBe(200);
    expect(search.body.data.mode).toBe('keyword');
    expect(search.body.data.results[0].source.id).toBe(source.id);

    const usage = await request(app).get('/api/usage').set(user.auth);
    expect(usage.body.data.usage.provider.generation.state).toBe('quota_exhausted');
    expect(usage.body.data.usage.provider.embedding.state).toBe('quota_exhausted');
  });
});
