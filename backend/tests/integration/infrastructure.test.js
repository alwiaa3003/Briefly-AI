'use strict';

/**
 * End-to-end infrastructure checks against REAL services.
 *
 * Prerequisites (see README "Running tests"):
 *   - MongoDB and Redis running (docker compose up -d)
 *   - Python processing service running on PROCESSING_SERVICE_URL
 *   - backend/.env configured (same INTERNAL_SERVICE_SECRET as the Python service)
 *
 *   npm run test:infra
 */

const mongoose = require('mongoose');
const request = require('supertest');
const { connectDatabase, disconnectDatabase, pingDatabase } = require('../../src/config/database');
const { waitForSharedRedis, closeSharedRedisConnection } = require('../../src/config/redis');
const { getProcessingQueue, closeProcessingQueue } = require('../../src/queues/processingQueue');
const { createProcessingWorker } = require('../../src/workers/processingWorker');
const processingClient = require('../../src/services/processingClient');
const { createApp } = require('../../src/app');

const app = createApp();
let worker;

beforeAll(async () => {
  await connectDatabase();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.syncIndexes();
  await waitForSharedRedis(10000);
  await getProcessingQueue().obliterate({ force: true });
});

afterAll(async () => {
  if (worker) await worker.close();
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await closeProcessingQueue();
  await closeSharedRedisConnection();
  await disconnectDatabase();
});

async function waitForJob(token, jobId, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app).get(`/api/jobs/${jobId}`).set('Authorization', `Bearer ${token}`);
    const { job } = res.body.data;
    if (job.status === 'completed' || job.status === 'failed') return job;
    if (Date.now() > deadline) throw new Error(`Job ${jobId} did not finish; last status: ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('Infrastructure', () => {
  test('MongoDB connection works', async () => {
    await expect(pingDatabase()).resolves.toBeUndefined();
    expect(mongoose.connection.name).toBe('briefly_ai_infra_test');
  });

  test('Redis connection works', async () => {
    const redis = await waitForSharedRedis();
    await expect(redis.ping()).resolves.toBe('PONG');
  });

  test('Python processing service is reachable and accepts the internal secret', async () => {
    const health = await processingClient.checkHealth();
    expect(health.status).toBe('ok');

    const result = await processingClient.runInternalTest({ message: 'direct call', jobId: 'infra-direct' });
    expect(result).toMatchObject({ echo: 'direct call', job_id: 'infra-direct', processed_by: 'briefly-processing-service' });
  });

  test('readiness endpoint reports every dependency as up', async () => {
    const res = await request(app).get('/api/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.services).toEqual({
      database: expect.objectContaining({ status: 'up' }),
      redis: expect.objectContaining({ status: 'up' }),
      processingService: expect.objectContaining({ status: 'up' }),
    });
  });

  test('BullMQ test job flows API -> queue -> worker -> Python -> completed', async () => {
    worker = createProcessingWorker({ concurrency: 1 });
    await worker.waitUntilReady();

    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Infra Tester', email: 'infra@example.com', password: 'pipeline1' });
    expect(registerRes.status).toBe(201);
    const token = registerRes.body.data.accessToken;

    const createRes = await request(app)
      .post('/api/jobs/test')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Hello from the infrastructure test' });
    expect(createRes.status).toBe(202);
    expect(createRes.body.data.job.status).toBe('queued');

    const job = await waitForJob(token, createRes.body.data.job.id);

    expect(job.status).toBe('completed');
    expect(job.attempts).toBe(1);
    expect(job.completedAt).toBeDefined();
    expect(job.result.processingService).toMatchObject({
      echo: 'Hello from the infrastructure test',
      job_id: createRes.body.data.job.id,
      message_length: 'Hello from the infrastructure test'.length,
      processed_by: 'briefly-processing-service',
    });
  });
});
