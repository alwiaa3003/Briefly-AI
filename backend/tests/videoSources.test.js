'use strict';

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/storageService', () => require('./helpers/storageMock'));

const mongoose = require('mongoose');
const request = require('supertest');
const queueMock = require('./helpers/queueMock');
const storageMock = require('./helpers/storageMock');
const bytes = require('./helpers/videoBytes');
const { createApp } = require('../src/app');
const Source = require('../src/models/Source');
const Upload = require('../src/models/Upload');
const Transcript = require('../src/models/Transcript');
const ProcessingJob = require('../src/models/ProcessingJob');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
const ID = 'dQw4w9WgXcQ';

let counter = 0;
async function signUp() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Viewer', email: `viewer${counter}@example.com`, password: 'watching123' });
  return { auth: { Authorization: `Bearer ${res.body.data.accessToken}` }, userId: res.body.data.user.id };
}

const submitYouTube = (auth, url) => request(app).post('/api/videos/youtube').set(auth).send({ url });
const uploadVideo = (auth, salt = 1) =>
  request(app).post('/api/videos/uploads').set(auth).attach('file', bytes.mp4(4096, salt), { filename: 'Lecture.mp4', contentType: 'video/mp4' });

async function addTranscript(sourceId, userId) {
  const transcript = await Transcript.create({
    user: userId,
    source: sourceId,
    origin: 'youtube_video',
    provider: 'gemini',
    model: 'gemini-test',
    language: 'en',
    segments: [
      { start: 0, end: 5, text: 'Welcome to the lecture.', speaker: 'Speaker 1' },
      { start: 5, end: 12, text: 'Today: urban trees.', speaker: null },
    ],
    wordCount: 7,
    completedAt: new Date(),
  });
  await Source.updateOne({ _id: sourceId }, { $set: { transcript: transcript._id } });
  return transcript;
}

beforeAll(startTestDatabase);
beforeEach(() => {
  queueMock.__reset();
  storageMock.__reset();
});
afterEach(clearTestDatabase);
afterAll(stopTestDatabase);

describe('POST /api/videos/youtube', () => {
  test('requires authentication', async () => {
    expect((await request(app).post('/api/videos/youtube').send({ url: `https://youtu.be/${ID}` })).status).toBe(401);
  });

  test('creates a youtube source and queues a summarize_youtube job', async () => {
    const { auth } = await signUp();
    const res = await submitYouTube(auth, `https://youtu.be/${ID}?si=share`);

    expect(res.status).toBe(202);
    expect(res.body.data.source).toMatchObject({
      kind: 'youtube',
      status: 'queued',
      submittedUrl: `https://www.youtube.com/watch?v=${ID}`,
      video: { platform: 'youtube', videoId: ID },
    });
    const job = await ProcessingJob.findById(res.body.data.job.id);
    expect(job.type).toBe('summarize_youtube');
  });

  test('every URL form of the same video is one source (duplicate detection)', async () => {
    const { auth } = await signUp();
    const first = await submitYouTube(auth, `https://www.youtube.com/watch?v=${ID}`);
    const second = await submitYouTube(auth, `https://www.youtube.com/shorts/${ID}`);
    const third = await submitYouTube(auth, `https://youtu.be/${ID}?t=30`);

    expect([second.status, third.status]).toEqual([200, 200]);
    expect(second.body.data.duplicate).toBe(true);
    expect(third.body.data.source.id).toBe(first.body.data.source.id);
    expect(queueMock.__state.added).toHaveLength(1);
  });

  test.each([
    ['', 'VALIDATION_ERROR'],
    ['https://vimeo.com/123456', 'INVALID_YOUTUBE_URL'],
    ['https://www.youtube.com/playlist?list=PL1', 'INVALID_YOUTUBE_URL'],
    ['https://www.youtube.com/watch?v=bad', 'INVALID_YOUTUBE_URL'],
    ['javascript:alert(1)', 'INVALID_YOUTUBE_URL'],
  ])('rejects %p with %s', async (url, code) => {
    const { auth } = await signUp();
    const res = await submitYouTube(auth, url);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(await Source.countDocuments()).toBe(0);
  });

  test('library filters by kind', async () => {
    const { auth } = await signUp();
    await submitYouTube(auth, `https://youtu.be/${ID}`);
    await request(app).post('/api/articles').set(auth).send({ url: 'https://news.example.com/a' });
    await uploadVideo(auth);

    for (const [kind, count] of [['youtube', 1], ['video', 1], ['article', 1]]) {
      const res = await request(app).get(`/api/sources?kind=${kind}`).set(auth);
      expect(res.body.data.items).toHaveLength(count);
      expect(res.body.data.items[0].kind).toBe(kind);
    }
  });
});

describe('GET /api/sources/:id/transcript', () => {
  test('returns the transcript to its owner only', async () => {
    const owner = await signUp();
    const intruder = await signUp();
    const created = await submitYouTube(owner.auth, `https://youtu.be/${ID}`);
    await addTranscript(created.body.data.source.id, owner.userId);

    const res = await request(app).get(`/api/sources/${created.body.data.source.id}/transcript`).set(owner.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.transcript).toMatchObject({ language: 'en', provider: 'gemini', origin: 'youtube_video' });
    expect(res.body.data.transcript.segments[0]).toEqual({ start: 0, end: 5, text: 'Welcome to the lecture.', speaker: 'Speaker 1' });
    expect(res.body.data.transcript.user).toBeUndefined();

    const denied = await request(app).get(`/api/sources/${created.body.data.source.id}/transcript`).set(intruder.auth);
    expect(denied.status).toBe(404);
  });

  test('404 while no transcript exists, and the detail page says so honestly', async () => {
    const { auth } = await signUp();
    const created = await submitYouTube(auth, `https://youtu.be/${ID}`);

    const res = await request(app).get(`/api/sources/${created.body.data.source.id}/transcript`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TRANSCRIPT_NOT_FOUND');

    const detail = await request(app).get(`/api/sources/${created.body.data.source.id}`).set(auth);
    expect(detail.body.data.source.transcript).toEqual({ available: false });
  });

  test('an unfinished (partial) transcript is not exposed', async () => {
    const { auth, userId } = await signUp();
    const created = await submitYouTube(auth, `https://youtu.be/${ID}`);
    const transcript = await addTranscript(created.body.data.source.id, userId);
    await Transcript.updateOne({ _id: transcript._id }, { $set: { completedAt: null } });

    const res = await request(app).get(`/api/sources/${created.body.data.source.id}/transcript`).set(auth);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/sources/:id/playback', () => {
  test('gives the owner a short-lived inline URL for an uploaded video', async () => {
    const { auth } = await signUp();
    const created = await uploadVideo(auth);

    const res = await request(app).get(`/api/sources/${created.body.data.source.id}/playback`).set(auth);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.playback.url).toMatch(/^https:\/\/.*X-Amz-Signature/);
    const signed = storageMock.__state.signed.at(-1);
    expect(signed).toMatchObject({ inline: true, contentType: 'video/mp4' });
    expect(signed.ttlSeconds).toBeLessThanOrEqual(3600);
  });

  test("another user cannot obtain a download URL for someone else's video", async () => {
    const owner = await signUp();
    const intruder = await signUp();
    const created = await uploadVideo(owner.auth);

    const res = await request(app).get(`/api/sources/${created.body.data.source.id}/playback`).set(intruder.auth);
    expect(res.status).toBe(404);
    expect(storageMock.__state.signed).toHaveLength(0);
  });

  test('410 after the file has been cleaned up', async () => {
    const { auth } = await signUp();
    const created = await uploadVideo(auth);
    await Upload.updateMany({}, { $set: { status: 'deleted' } });

    const res = await request(app).get(`/api/sources/${created.body.data.source.id}/playback`).set(auth);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('UPLOAD_EXPIRED');
  });

  test('not available for YouTube sources', async () => {
    const { auth } = await signUp();
    const created = await submitYouTube(auth, `https://youtu.be/${ID}`);
    const res = await request(app).get(`/api/sources/${created.body.data.source.id}/playback`).set(auth);
    expect(res.status).toBe(404);
  });

  test('the detail endpoint never exposes storage keys or hashes', async () => {
    const { auth } = await signUp();
    const created = await uploadVideo(auth);
    const res = await request(app).get(`/api/sources/${created.body.data.source.id}`).set(auth);

    expect(res.body.data.source.upload).toMatchObject({ originalName: 'Lecture.mp4', container: 'mp4', available: true });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/videos\/[0-9a-f]{24}\//);
    expect(body).not.toContain('sha256');
  });
});

describe('retry for videos', () => {
  test('re-queues a failed YouTube summary with the right job type', async () => {
    const { auth } = await signUp();
    const created = await submitYouTube(auth, `https://youtu.be/${ID}`);
    await Source.updateOne({ _id: created.body.data.source.id }, { $set: { status: 'failed' } });

    const res = await request(app).post(`/api/sources/${created.body.data.source.id}/retry`).set(auth);
    expect(res.status).toBe(202);
    expect((await ProcessingJob.findById(res.body.data.job.id)).type).toBe('summarize_youtube');
  });

  test('refuses to retry an upload whose file is gone', async () => {
    const { auth } = await signUp();
    const created = await uploadVideo(auth);
    await Source.updateOne({ _id: created.body.data.source.id }, { $set: { status: 'failed' } });
    await Upload.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post(`/api/sources/${created.body.data.source.id}/retry`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UPLOAD_EXPIRED');
  });

  test('re-uploading the same file after a failure re-queues the existing source', async () => {
    const { auth } = await signUp();
    const first = await uploadVideo(auth, 42);
    await Source.updateOne({ _id: first.body.data.source.id }, { $set: { status: 'failed' } });

    const second = await uploadVideo(auth, 42);

    expect(second.status).toBe(202);
    expect(second.body.data.source.id).toBe(first.body.data.source.id);
    const source = await Source.findById(first.body.data.source.id);
    const newest = await Upload.findById(source.upload);
    expect(newest.status).toBe('stored');
    expect(await Upload.countDocuments({ expiresAt: { $lte: new Date() } })).toBe(1); // old copy scheduled for cleanup
  });
});

test('sources of different users never mix', async () => {
  const a = await signUp();
  const b = await signUp();
  await submitYouTube(a.auth, `https://youtu.be/${ID}`);
  const res = await request(app).get('/api/sources').set(b.auth);
  expect(res.body.data.total).toBe(0);
  expect(await Source.countDocuments({ user: new mongoose.Types.ObjectId(b.userId) })).toBe(0);
});
