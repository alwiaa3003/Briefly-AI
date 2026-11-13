'use strict';

/** Ask AI conversations and smart search through the HTTP API (processing service mocked). */

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return { ...actual, embedTexts: jest.fn(), answerQuestion: jest.fn() };
});

const request = require('supertest');
const processingClient = require('../src/services/processingClient');
const queueMock = require('./helpers/queueMock');
const { createApp } = require('../src/app');
const Source = require('../src/models/Source');
const Message = require('../src/models/Message');
const Conversation = require('../src/models/Conversation');
const { fakeEmbedTexts, seedIndexedSource } = require('./helpers/rag');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
let counter = 0;
async function signUp() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Reader Person', email: `chat${counter}@example.com`, password: 'reading123' });
  return { userId: res.body.data.user.id, auth: { Authorization: `Bearer ${res.body.data.accessToken}` } };
}

function answer(overrides = {}) {
  return {
    answer: { answer: 'Trees cool streets by 2 degrees.', support: 'supported', citations: ['c1'], follow_up_questions: ['Why?'], ...overrides },
    model: 'fake-gemini',
    citations_discarded: 0,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

beforeAll(startTestDatabase);
beforeEach(() => {
  queueMock.__reset();
  processingClient.embedTexts.mockImplementation(fakeEmbedTexts);
  processingClient.answerQuestion.mockResolvedValue(answer());
});
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

async function setup() {
  const alice = await signUp();
  const bob = await signUp();
  const aliceSource = await seedIndexedSource(alice.userId, {
    kind: 'document',
    title: 'Urban Heat Report',
    chunks: [
      { text: 'Urban trees cool streets by two degrees through shade.', page: 4, label: 'p. 4' },
      { text: 'Maintenance budgets for city parks were cut in 2023.', page: 9, label: 'p. 9' },
    ],
  });
  const aliceOther = await seedIndexedSource(alice.userId, { title: 'Coffee guide', chunks: ['Espresso brewing needs fine coffee grounds.'] });
  const bobSource = await seedIndexedSource(bob.userId, {
    title: 'Bob private notes',
    chunks: ['Urban trees cool streets. BOB-PRIVATE salary figures and secrets.'],
  });
  return { alice, bob, aliceSource, aliceOther, bobSource };
}

const newChat = (auth, body) => request(app).post('/api/conversations').set(auth).send(body);
const ask = (auth, id, content) => request(app).post(`/api/conversations/${id}/messages`).set(auth).send({ content });

describe('conversations', () => {
  test('source conversation: only that source’s chunks are sent, citations resolve to pages', async () => {
    const { alice, aliceSource } = await setup();
    const chat = await newChat(alice.auth, { scope: 'source', sourceId: aliceSource.id });
    expect(chat.status).toBe(201);
    expect(chat.body.data.conversation.source).toMatchObject({ id: aliceSource.id, title: 'Urban Heat Report' });

    const res = await ask(alice.auth, chat.body.data.conversation.id, 'How much do trees cool streets?');
    expect(res.status).toBe(201);
    const [userMsg, reply] = res.body.data.messages;
    expect(userMsg).toMatchObject({ role: 'user', content: 'How much do trees cool streets?' });
    expect(reply).toMatchObject({ role: 'assistant', support: 'supported', followUps: ['Why?'] });
    expect(reply.citations[0]).toMatchObject({ source: aliceSource.id, page: 4, label: 'p. 4', sourceTitle: 'Urban Heat Report' });
    expect(res.body.data.conversation.title).toBe('How much do trees cool streets?');

    const sent = processingClient.answerQuestion.mock.calls[0][0];
    expect(sent.scope).toBe('source');
    expect(sent.chunks.length).toBeGreaterThan(0);
    expect(sent.chunks.every((c) => c.sourceId === aliceSource.id)).toBe(true);
    expect(sent.chunks.map((c) => c.id)).toEqual(sent.chunks.map((_, i) => `c${i + 1}`));
  });

  test('library conversation never retrieves another user’s content', async () => {
    const { alice } = await setup();
    const chat = await newChat(alice.auth, { scope: 'library' });
    await ask(alice.auth, chat.body.data.conversation.id, 'urban trees secrets salary');
    const sent = processingClient.answerQuestion.mock.calls[0][0];
    expect(sent.chunks.some((c) => /BOB-PRIVATE/.test(c.text))).toBe(false);
  });

  test('cannot open a conversation on someone else’s source', async () => {
    const { alice, bobSource } = await setup();
    const res = await newChat(alice.auth, { scope: 'source', sourceId: bobSource.id });
    expect(res.status).toBe(404);
  });

  test('other users cannot read, post to, rename or delete a conversation', async () => {
    const { alice, bob } = await setup();
    const id = (await newChat(alice.auth, { scope: 'library' })).body.data.conversation.id;
    expect((await request(app).get(`/api/conversations/${id}`).set(bob.auth)).status).toBe(404);
    expect((await ask(bob.auth, id, 'hello')).status).toBe(404);
    expect((await request(app).patch(`/api/conversations/${id}`).set(bob.auth).send({ title: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/conversations/${id}`).set(bob.auth)).status).toBe(404);
    expect((await request(app).get('/api/conversations').set(bob.auth)).body.data.items).toEqual([]);
  });

  test('history is persisted, bounded and sent for follow-ups', async () => {
    const { alice, aliceSource } = await setup();
    const id = (await newChat(alice.auth, { scope: 'source', sourceId: aliceSource.id })).body.data.conversation.id;
    for (let i = 0; i < 6; i += 1) await ask(alice.auth, id, `Question ${i} about trees?`);
    const last = processingClient.answerQuestion.mock.calls[5][0];
    expect(last.history).toHaveLength(8); // CHAT_HISTORY_MESSAGES default
    expect(last.history[last.history.length - 1].role).toBe('assistant');

    const full = await request(app).get(`/api/conversations/${id}`).set(alice.auth);
    expect(full.body.data.messages).toHaveLength(12);
    expect(full.body.data.conversation.messageCount).toBe(12);
  });

  test('not-found answers are stored without citations', async () => {
    const { alice, aliceSource } = await setup();
    processingClient.answerQuestion.mockResolvedValue(answer({ support: 'not_found', citations: [], answer: "The source doesn't say." }));
    const id = (await newChat(alice.auth, { scope: 'source', sourceId: aliceSource.id })).body.data.conversation.id;
    const res = await ask(alice.auth, id, 'What is the capital of Mars?');
    expect(res.body.data.messages[1]).toMatchObject({ support: 'not_found', citations: [] });
  });

  test('citations the backend did not supply are ignored', async () => {
    const { alice, aliceSource } = await setup();
    processingClient.answerQuestion.mockResolvedValue(answer({ citations: ['c1', 'c999'] }));
    const id = (await newChat(alice.auth, { scope: 'source', sourceId: aliceSource.id })).body.data.conversation.id;
    const res = await ask(alice.auth, id, 'trees?');
    expect(res.body.data.messages[1].citations).toHaveLength(1);
  });

  test('a source without chunks queues indexing and asks to wait', async () => {
    const { alice } = await setup();
    const fresh = await Source.create({
      user: alice.userId,
      kind: 'article',
      submittedUrl: 'https://example.com/fresh',
      normalizedUrl: 'fresh',
      status: 'completed',
    });
    const id = (await newChat(alice.auth, { scope: 'source', sourceId: fresh.id })).body.data.conversation.id;
    expect(queueMock.__state.added.map((j) => j.type)).toEqual(['index_source']);
    const res = await ask(alice.auth, id, 'Anything?');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SOURCE_NOT_INDEXED');
    expect(processingClient.answerQuestion).not.toHaveBeenCalled();
  });

  test('AI failures return a safe error and do not leave an unanswered question', async () => {
    const { alice } = await setup();
    processingClient.answerQuestion.mockRejectedValue(
      new processingClient.ProcessingServiceError('AI features are not configured on the server.', { code: 'AI_NOT_CONFIGURED', retryable: false })
    );
    const id = (await newChat(alice.auth, { scope: 'library' })).body.data.conversation.id;
    const res = await ask(alice.auth, id, 'trees?');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
    expect(await Message.countDocuments()).toBe(0);
  });

  test('question validation and source readiness', async () => {
    const { alice } = await setup();
    const id = (await newChat(alice.auth, { scope: 'library' })).body.data.conversation.id;
    expect((await ask(alice.auth, id, '   ')).status).toBe(400);
    expect((await ask(alice.auth, id, 'x'.repeat(2001))).status).toBe(400);
    expect((await newChat(alice.auth, { scope: 'source' })).status).toBe(400);
    const pending = await Source.create({ user: alice.userId, kind: 'article', submittedUrl: 'https://e.com/p', normalizedUrl: 'p', status: 'summarizing' });
    expect((await newChat(alice.auth, { scope: 'source', sourceId: pending.id })).status).toBe(409);
  });

  test('delete removes the conversation and its messages', async () => {
    const { alice } = await setup();
    const id = (await newChat(alice.auth, { scope: 'library' })).body.data.conversation.id;
    await ask(alice.auth, id, 'trees?');
    expect((await request(app).delete(`/api/conversations/${id}`).set(alice.auth)).status).toBe(200);
    expect(await Conversation.countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
  });

  test('list filters by source and requires authentication', async () => {
    const { alice, aliceSource } = await setup();
    await newChat(alice.auth, { scope: 'source', sourceId: aliceSource.id });
    await newChat(alice.auth, { scope: 'library' });
    const bySource = await request(app).get(`/api/conversations?sourceId=${aliceSource.id}`).set(alice.auth);
    expect(bySource.body.data.items).toHaveLength(1);
    expect((await request(app).get('/api/conversations')).status).toBe(401);
  });
});

describe('search', () => {
  test('returns the caller’s matching sources with previews and locations', async () => {
    const { alice, aliceSource } = await setup();
    const res = await request(app).get('/api/search').query({ q: 'trees cooling streets' }).set(alice.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('hybrid');
    const [first] = res.body.data.results;
    expect(first.source).toMatchObject({ id: aliceSource.id, title: 'Urban Heat Report', kind: 'document' });
    expect(first.matches[0]).toMatchObject({ page: 4, label: 'p. 4' });
    expect(JSON.stringify(res.body)).not.toMatch(/BOB-PRIVATE|Bob private/);
  });

  test('type and date filters', async () => {
    const { alice } = await setup();
    const docs = await request(app).get('/api/search').query({ q: 'coffee espresso', kind: 'document' }).set(alice.auth);
    expect(docs.body.data.results.every((r) => r.source.kind === 'document')).toBe(true);
    const future = await request(app).get('/api/search').query({ q: 'trees', from: '2999-01-01' }).set(alice.auth);
    expect(future.body.data.results).toEqual([]);
    expect((await request(app).get('/api/search').query({ q: 'trees', from: '01/01/2020' }).set(alice.auth)).status).toBe(400);
  });

  test('falls back to keyword search when embeddings are unavailable', async () => {
    const { alice, aliceOther } = await setup();
    processingClient.embedTexts.mockRejectedValue(new Error('down'));
    const res = await request(app).get('/api/search').query({ q: 'espresso' }).set(alice.auth);
    expect(res.body.data.mode).toBe('keyword');
    expect(res.body.data.results[0].source.id).toBe(aliceOther.id);
  });

  test('title matches are found even without chunk matches', async () => {
    const { alice, aliceOther } = await setup();
    const res = await request(app).get('/api/search').query({ q: 'Coffee guide' }).set(alice.auth);
    expect(res.body.data.results.some((r) => r.source.id === aliceOther.id && r.titleMatch)).toBe(true);
  });

  test('validation and auth', async () => {
    const { alice } = await setup();
    expect((await request(app).get('/api/search').query({ q: 'a' }).set(alice.auth)).status).toBe(400);
    expect((await request(app).get('/api/search').query({ q: 'trees' })).status).toBe(401);
  });
});
