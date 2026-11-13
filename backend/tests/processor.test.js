'use strict';

/**
 * Unit tests for the shared BullMQ processor: status transitions, bounded
 * retries and failure handling. The processing-service HTTP client is
 * replaced with a jest mock; the real round-trip is covered by
 * tests/integration/infrastructure.test.js.
 */

jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return { ...actual, runInternalTest: jest.fn() };
});

const mongoose = require('mongoose');
const { UnrecoverableError } = require('bullmq');
const processingClient = require('../src/services/processingClient');
const { ProcessingServiceError } = processingClient;
const ProcessingJob = require('../src/models/ProcessingJob');
const { processJob } = require('../src/workers/processor');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

beforeAll(startTestDatabase);
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

async function createJobRecord(type = 'test') {
  return ProcessingJob.create({
    user: new mongoose.Types.ObjectId(),
    type,
    input: { message: 'ping' },
    maxAttempts: 3,
  });
}

/** Minimal stand-in for a BullMQ Job: only the fields the processor reads. */
function fakeBullJob(record, { attemptsMade = 0, attempts = 3, type = record.type } = {}) {
  return {
    data: { processingJobId: record.id, type, input: record.input },
    attemptsMade,
    opts: { attempts },
  };
}

describe('processJob', () => {
  test('marks the job completed and stores the handler result', async () => {
    const record = await createJobRecord();
    processingClient.runInternalTest.mockResolvedValue({ echo: 'ping', processed_by: 'processing-service' });

    const result = await processJob(fakeBullJob(record));

    expect(processingClient.runInternalTest).toHaveBeenCalledWith({ message: 'ping', jobId: record.id });
    expect(result).toEqual({ processingService: { echo: 'ping', processed_by: 'processing-service' } });

    const updated = await ProcessingJob.findById(record.id);
    expect(updated.status).toBe('completed');
    expect(updated.attempts).toBe(1);
    expect(updated.result).toEqual(result);
    expect(updated.completedAt).toBeInstanceOf(Date);
    expect(updated.error).toBeNull();
  });

  test('a retryable failure before the last attempt re-queues the job and rethrows', async () => {
    const record = await createJobRecord();
    const error = new ProcessingServiceError('The processing service is unreachable.', {
      code: 'PROCESSING_SERVICE_UNREACHABLE',
      retryable: true,
    });
    processingClient.runInternalTest.mockRejectedValue(error);

    await expect(processJob(fakeBullJob(record, { attemptsMade: 0 }))).rejects.toBe(error);

    const updated = await ProcessingJob.findById(record.id);
    expect(updated.status).toBe('queued');
    expect(updated.attempts).toBe(1);
    expect(updated.error).toMatchObject({ code: 'PROCESSING_SERVICE_UNREACHABLE' });
  });

  test('a retryable failure on the final attempt marks the job failed', async () => {
    const record = await createJobRecord();
    processingClient.runInternalTest.mockRejectedValue(
      new ProcessingServiceError('The processing service timed out.', { code: 'PROCESSING_SERVICE_TIMEOUT', retryable: true })
    );

    await expect(processJob(fakeBullJob(record, { attemptsMade: 2, attempts: 3 }))).rejects.toThrow('timed out');

    const updated = await ProcessingJob.findById(record.id);
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(3);
    expect(updated.failedAt).toBeInstanceOf(Date);
    expect(updated.error).toMatchObject({ code: 'PROCESSING_SERVICE_TIMEOUT' });
  });

  test('a non-retryable failure fails immediately with UnrecoverableError (no more retries)', async () => {
    const record = await createJobRecord();
    processingClient.runInternalTest.mockRejectedValue(
      new ProcessingServiceError('The processing service responded with HTTP 401.', {
        code: 'PROCESSING_UNAUTHORIZED',
        status: 401,
        retryable: false,
      })
    );

    await expect(processJob(fakeBullJob(record, { attemptsMade: 0 }))).rejects.toBeInstanceOf(UnrecoverableError);

    const updated = await ProcessingJob.findById(record.id);
    expect(updated.status).toBe('failed');
    expect(updated.attempts).toBe(1);
    expect(updated.error).toMatchObject({ code: 'PROCESSING_UNAUTHORIZED' });
  });

  test('unexpected errors are stored with a generic message', async () => {
    const record = await createJobRecord();
    processingClient.runInternalTest.mockRejectedValue(new Error('secret internal detail'));

    await expect(processJob(fakeBullJob(record, { attemptsMade: 2, attempts: 3 }))).rejects.toThrow();

    const updated = await ProcessingJob.findById(record.id);
    expect(updated.status).toBe('failed');
    expect(updated.toObject().error).toEqual({ code: 'JOB_FAILED', message: 'The job failed due to an internal error.' });
  });

  test('an unknown job type fails permanently without calling any handler', async () => {
    const record = await createJobRecord();

    await expect(processJob(fakeBullJob(record, { type: 'nonexistent' }))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(processingClient.runInternalTest).not.toHaveBeenCalled();
    const updated = await ProcessingJob.findById(record.id);
    expect(updated.status).toBe('failed');
    expect(updated.error.code).toBe('UNKNOWN_JOB_TYPE');
  });
});
