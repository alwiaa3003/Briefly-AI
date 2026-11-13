'use strict';

/**
 * The article rate limit is counted per user (not per IP). The app is loaded in
 * an isolated module registry so this file can use a low limit.
 */

const request = require('supertest');

let app;
let queueMock;
let db;
let Conversation;

beforeAll(async () => {
  process.env.ARTICLE_RATE_LIMIT_MAX = '2';
  process.env.CHAT_RATE_LIMIT_MAX = '1';
  jest.isolateModules(() => {
    jest.doMock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
    queueMock = require('./helpers/queueMock');
    db = require('./helpers/db');
    app = require('../src/app').createApp();
    Conversation = require('../src/models/Conversation');
  });
  await db.startTestDatabase();
});

afterAll(async () => {
  process.env.ARTICLE_RATE_LIMIT_MAX = '1000';
  process.env.CHAT_RATE_LIMIT_MAX = '1000';
  await db.stopTestDatabase();
});

async function signUp(email) {
  const res = await request(app).post('/api/auth/register').send({ name: 'Limit Tester', email, password: 'limits123' });
  return { Authorization: `Bearer ${res.body.data.accessToken}` };
}

test('article submissions are limited per user', async () => {
  queueMock.__reset();
  const alice = await signUp('alice@example.com');
  const bob = await signUp('bob@example.com');

  const first = await request(app).post('/api/articles').set(alice).send({ url: 'https://example.com/a' });
  const second = await request(app).post('/api/articles').set(alice).send({ url: 'https://example.com/b' });
  const third = await request(app).post('/api/articles').set(alice).send({ url: 'https://example.com/c' });

  expect([first.status, second.status]).toEqual([202, 202]);
  expect(third.status).toBe(429);
  expect(third.body.error.code).toBe('RATE_LIMITED');

  // A different user from the same IP is unaffected.
  const other = await request(app).post('/api/articles').set(bob).send({ url: 'https://example.com/a' });
  expect(other.status).toBe(202);
});

test('Ask AI questions are limited per user', async () => {
  const res = await request(app).post('/api/auth/register').send({ name: 'Chat Tester', email: 'chat-limit@example.com', password: 'limits123' });
  const auth = { Authorization: `Bearer ${res.body.data.accessToken}` };
  const conversation = await Conversation.create({ user: res.body.data.user.id, scope: 'library' });
  // The first request passes the limiter (and then fails: the AI service is unreachable in tests).
  const first = await request(app).post(`/api/conversations/${conversation.id}/messages`).set(auth).send({ content: 'hello?' });
  expect(first.status).not.toBe(429);
  const second = await request(app).post(`/api/conversations/${conversation.id}/messages`).set(auth).send({ content: 'hello?' });
  expect(second.status).toBe(429);
  expect(second.body.error.code).toBe('RATE_LIMITED');
});
