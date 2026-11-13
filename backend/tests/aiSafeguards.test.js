'use strict';

/**
 * Quota safeguards:
 *   1. The worker only consumes jobs once the shared Redis (AI budgets) is ready, and AI
 *      calls never fall back to per-process counting when the shared store is required.
 *   4. Invalid AI output (after the processing service's own in-call retry) fails the job
 *      instead of re-running it; transient failures keep the existing job-level retries.
 */

jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return { ...actual, runInternalTest: jest.fn() };
});

const mongoose = require('mongoose');
const { UnrecoverableError, DelayedError } = require('bullmq');
const processingClient = require('../src/services/processingClient');
const { ProcessingServiceError } = processingClient;
const ProcessingJob = require('../src/models/ProcessingJob');
const { processJob, backoffStrategy } = require('../src/workers/processor');
const { startWorker } = require('../src/workers/index');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

beforeAll(startTestDatabase);
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

async function createJobRecord() {
  return ProcessingJob.create({ user: new mongoose.Types.ObjectId(), type: 'test', input: { message: 'ping' }, maxAttempts: 3 });
}

function fakeBullJob(record, { attemptsMade = 0, attempts = 3 } = {}) {
  return {
    data: { processingJobId: record.id, type: 'test', input: record.input },
    attemptsMade,
    opts: { attempts },
    updateData: jest.fn(async function updateData(data) {
      this.data = data;
    }),
    moveToDelayed: jest.fn(async () => {}),
  };
}

/* ------------------------------ 1. Redis readiness ------------------------------ */

function fakeDeps() {
  const order = [];
  let resolveRedis;
  const deps = {
    connectDatabase: jest.fn(async () => order.push('database')),
    waitForSharedRedis: jest.fn(
      () =>
        new Promise((resolve) => {
          resolveRedis = () => {
            order.push('redis-ready');
            resolve();
          };
        })
    ),
    requireSharedStore: jest.fn(() => order.push('shared-store-required')),
    createProcessingWorker: jest.fn(() => {
      order.push('worker-created');
      return { name: 'processing', waitUntilReady: jest.fn(async () => {}), close: jest.fn() };
    }),
    startMaintenance: jest.fn(),
    isStorageConfigured: () => false,
  };
  return { deps, order, redisReady: () => resolveRedis() };
}

describe('worker startup waits for the shared Redis', () => {
  test('no worker (and so no job) exists until Redis is ready; the shared store is made mandatory first', async () => {
    const { deps, order, redisReady } = fakeDeps();
    const started = startWorker({ ...deps, redisReadyTimeoutMs: 5000 });

    // Give the startup sequence every chance to run ahead.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deps.waitForSharedRedis).toHaveBeenCalledWith(5000);
    expect(deps.createProcessingWorker).not.toHaveBeenCalled();
    expect(deps.requireSharedStore).not.toHaveBeenCalled();

    redisReady();
    await started;
    expect(order).toEqual(['database', 'redis-ready', 'shared-store-required', 'worker-created']);
    expect(deps.requireSharedStore).toHaveBeenCalledWith(true);
  });

  test('if Redis never becomes ready, startup fails clearly and no worker is created', async () => {
    const { deps } = fakeDeps();
    deps.waitForSharedRedis.mockRejectedValue(new Error('Redis was not ready within 1000ms'));

    await expect(startWorker({ ...deps, redisReadyTimeoutMs: 1000 })).rejects.toMatchObject({
      code: 'WORKER_REDIS_NOT_READY',
      message: expect.stringContaining('will not process jobs'),
    });
    expect(deps.createProcessingWorker).not.toHaveBeenCalled();
    expect(deps.requireSharedStore).not.toHaveBeenCalled();
  });
});

describe('the AI gate never uses the in-memory fallback when the shared store is required', () => {
  function loadGate(store) {
    let gate;
    jest.isolateModules(() => {
      process.env.AI_GATE_STORE = store;
      gate = require('../src/services/ai/aiGate');
    });
    process.env.AI_GATE_STORE = 'memory';
    return gate;
  }

  test('required + Redis not ready: the call is refused before any budget is counted or Gemini is called', async () => {
    const gate = loadGate('auto');
    gate.requireSharedStore(true);
    const fn = jest.fn(async () => ({ data: { ok: true }, requests: 1 }));

    await expect(gate.withAiCall({ kind: 'generation', operation: 'summarize' }, fn)).rejects.toMatchObject({
      name: 'AiGateError',
      code: 'AI_BUDGET_UNAVAILABLE',
      retryable: true,
    });
    expect(fn).not.toHaveBeenCalled();
    expect(() => gate.getStore()).toThrow(expect.objectContaining({ code: 'AI_BUDGET_UNAVAILABLE' }));

    // Nothing was recorded anywhere: once the requirement is lifted, the memory store is empty.
    gate.requireSharedStore(false);
    expect(await gate.getStore().getHash(`usage:${gate.budgetDay()}`)).toEqual({});
  });

  test('without the requirement (unit tests / development) the existing behaviour is unchanged', async () => {
    const gate = loadGate('auto');
    const fn = jest.fn(async () => ({ data: { ok: true }, requests: 1 }));
    await expect(gate.withAiCall({ kind: 'generation', operation: 'summarize' }, fn)).resolves.toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('an explicit AI_GATE_STORE=memory is still honoured (deliberate single-process setup)', async () => {
    const gate = loadGate('memory');
    gate.requireSharedStore(true);
    const fn = jest.fn(async () => ({ data: { ok: true }, requests: 1 }));
    await expect(gate.withAiCall({ kind: 'generation', operation: 'summarize' }, fn)).resolves.toEqual({ ok: true });
  });

  test('a job that hits AI_BUDGET_UNAVAILABLE is deferred, not failed, and keeps its attempts', async () => {
    const record = await createJobRecord();
    processingClient.runInternalTest.mockRejectedValue(
      Object.assign(new Error("Briefly can't check its AI usage budget right now."), {
        name: 'AiGateError',
        code: 'AI_BUDGET_UNAVAILABLE',
        retryable: true,
        retryAfterMs: 15000,
      })
    );
    const job = fakeBullJob(record);

    await expect(processJob(job, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const updated = await ProcessingJob.findById(record.id);
    expect(updated.status).toBe('queued');
    expect(updated.error).toMatchObject({ code: 'AI_BUDGET_UNAVAILABLE' });
  });
});

/* ------------------------------ 4. invalid AI output ------------------------------ */

describe('invalid AI output does not trigger whole-job retries', () => {
  test.each([
    ['AI_INVALID_RESPONSE', false],
    // An older processing service still marks it retryable: the job must not repeat it either.
    ['AI_INVALID_RESPONSE', true],
    ['TRANSCRIPTION_INVALID_RESPONSE', true],
    ['OCR_INVALID_RESPONSE', true],
  ])('%s (retryable=%s) on the first of 3 attempts fails the job permanently', async (code, retryable) => {
    const record = await createJobRecord();
    processingClient.runInternalTest.mockRejectedValue(
      new ProcessingServiceError('The AI service returned an unusable result. Please try again later.', { code, retryable, status: 502 })
    );

    await expect(processJob(fakeBullJob(record, { attemptsMade: 0, attempts: 3 }))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(processingClient.runInternalTest).toHaveBeenCalledTimes(1);
    const updated = await ProcessingJob.findById(record.id);
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(1);
    expect(updated.error).toMatchObject({ code });
  });

  test.each([
    ['AI_UNAVAILABLE', 'The AI service is temporarily unavailable.'],
    ['AI_TIMEOUT', 'The AI request timed out.'],
    ['PROCESSING_SERVICE_UNREACHABLE', 'The processing service is unreachable.'],
    ['PROCESSING_SERVICE_TIMEOUT', 'The processing service did not respond in time.'],
  ])('transient %s keeps the job-level retry', async (code, message) => {
    const record = await createJobRecord();
    const error = new ProcessingServiceError(message, { code, retryable: true });
    processingClient.runInternalTest.mockRejectedValue(error);

    await expect(processJob(fakeBullJob(record, { attemptsMade: 0, attempts: 3 }))).rejects.toBe(error);

    const updated = await ProcessingJob.findById(record.id);
    expect(updated.status).toBe('queued'); // BullMQ will run attempt 2
    expect(updated.attempts).toBe(1);
  });

  test('rate limits are still deferred (no attempt consumed), as before', async () => {
    const record = await createJobRecord();
    processingClient.runInternalTest.mockRejectedValue(
      new ProcessingServiceError('Gemini is busy.', { code: 'AI_RATE_LIMITED', retryable: true, meta: { retry_after_seconds: 30 } })
    );
    const job = fakeBullJob(record);

    await expect(processJob(job, 'token')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
  });

  test('backoff: transient AI errors keep the longer wait; invalid output is no longer treated as transient', () => {
    const transient = backoffStrategy(1, 'custom', { code: 'AI_UNAVAILABLE' });
    const ordinary = backoffStrategy(1, 'custom', { code: 'PROCESSING_SERVICE_UNREACHABLE' });
    expect(transient).toBeGreaterThan(ordinary);
    expect(backoffStrategy(1, 'custom', { code: 'AI_INVALID_RESPONSE' })).toBe(ordinary);
  });
});

/* ------------------------------ 2. no real AI in unit tests ------------------------------ */

describe('backend unit tests cannot reach Gemini', () => {
  test('the processing service (the only path to Gemini) points at a closed port, and no Google SDK is installed', () => {
    const config = require('../src/config/env');
    expect(config.processingService.url).toBe('http://127.0.0.1:1');
    const pkg = require('../package.json');
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((name) => /google|genai|gemini/i.test(name))).toEqual([]);
  });

  test('an unmocked AI call (real client code) fails fast with a connection error', async () => {
    const actual = jest.requireActual('../src/services/processingClient');
    await expect(actual.embedTexts({ texts: ['hello'], task: 'query' })).rejects.toMatchObject({
      code: 'PROCESSING_SERVICE_UNREACHABLE',
    });
  });
});
