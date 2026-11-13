'use strict';

const request = require('supertest');
const { createApp } = require('../src/app');
const ProcessingJob = require('../src/models/ProcessingJob');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();

async function registerAndGetToken(email = 'grace@example.com') {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Grace Hopper', email, password: 'compiler1' });
  return res.body.data.accessToken;
}

beforeAll(startTestDatabase);
afterEach(clearTestDatabase);
afterAll(stopTestDatabase);

describe('Job routes', () => {
  test('POST /api/jobs/test requires authentication', async () => {
    const res = await request(app).post('/api/jobs/test').send({ message: 'hi' });
    expect(res.status).toBe(401);
  });

  test('GET /api/jobs/:id requires authentication', async () => {
    const res = await request(app).get('/api/jobs/507f1f77bcf86cd799439011');
    expect(res.status).toBe(401);
  });

  test('POST /api/jobs/test returns 503 and creates nothing when Redis is unavailable', async () => {
    // Redis is intentionally not running in unit tests.
    const token = await registerAndGetToken();
    const res = await request(app).post('/api/jobs/test').set('Authorization', `Bearer ${token}`).send({ message: 'hi' });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('QUEUE_UNAVAILABLE');
    expect(await ProcessingJob.countDocuments()).toBe(0);
  });

  test('POST /api/jobs/test validates the message', async () => {
    const token = await registerAndGetToken();
    const res = await request(app)
      .post('/api/jobs/test')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('GET /api/jobs/:id rejects malformed ids', async () => {
    const token = await registerAndGetToken();
    const res = await request(app).get('/api/jobs/not-an-id').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test("users cannot read another user's job", async () => {
    const ownerToken = await registerAndGetToken('owner@example.com');
    const owner = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${ownerToken}`);
    const job = await ProcessingJob.create({ user: owner.body.data.user.id, type: 'test', maxAttempts: 3 });

    const ownRes = await request(app).get(`/api/jobs/${job.id}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(ownRes.status).toBe(200);
    expect(ownRes.body.data.job).toMatchObject({ id: job.id, type: 'test', status: 'queued' });
    expect(ownRes.body.data.job.user).toBeUndefined();

    const otherToken = await registerAndGetToken('intruder@example.com');
    const otherRes = await request(app).get(`/api/jobs/${job.id}`).set('Authorization', `Bearer ${otherToken}`);
    expect(otherRes.status).toBe(404);
  });
});
