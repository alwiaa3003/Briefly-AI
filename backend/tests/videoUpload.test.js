'use strict';

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/storageService', () => require('./helpers/storageMock'));

const request = require('supertest');
const queueMock = require('./helpers/queueMock');
const storageMock = require('./helpers/storageMock');
const bytes = require('./helpers/videoBytes');
const { createApp } = require('../src/app');
const Source = require('../src/models/Source');
const Upload = require('../src/models/Upload');
const ProcessingJob = require('../src/models/ProcessingJob');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
const MAX = Number(process.env.UPLOAD_MAX_BYTES);

let counter = 0;
async function signUp() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Video Person', email: `video${counter}@example.com`, password: 'watching123' });
  return { auth: { Authorization: `Bearer ${res.body.data.accessToken}` }, userId: res.body.data.user.id };
}

function upload(auth, buffer, filename = 'Team sync.mp4', contentType = 'video/mp4') {
  return request(app).post('/api/videos/uploads').set(auth).attach('file', buffer, { filename, contentType });
}

beforeAll(startTestDatabase);
beforeEach(() => {
  queueMock.__reset();
  storageMock.__reset();
});
afterEach(clearTestDatabase);
afterAll(stopTestDatabase);

describe('GET /api/videos/uploads/config', () => {
  test('reports limits and whether uploads are enabled', async () => {
    const { auth } = await signUp();
    const res = await request(app).get('/api/videos/uploads/config').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.uploads).toMatchObject({ enabled: true, maxBytes: MAX, maxDurationMinutes: 180 });

    storageMock.__state.configured = false;
    const off = await request(app).get('/api/videos/uploads/config').set(auth);
    expect(off.body.data.uploads.enabled).toBe(false);
  });

  test('requires authentication', async () => {
    expect((await request(app).get('/api/videos/uploads/config')).status).toBe(401);
  });
});

describe('POST /api/videos/uploads', () => {
  test('requires authentication', async () => {
    const res = await request(app).post('/api/videos/uploads').attach('file', bytes.mp4(), 'a.mp4');
    expect(res.status).toBe(401);
    expect(storageMock.__state.objects.size).toBe(0);
  });

  test('streams a valid video to storage and queues a summarize_video_upload job', async () => {
    const { auth, userId } = await signUp();
    const buffer = bytes.mp4(8192);

    const res = await upload(auth, buffer, 'Team sync.mp4');

    expect(res.status).toBe(202);
    expect(res.body.data.source).toMatchObject({ kind: 'video', status: 'queued', submittedUrl: null });
    expect(res.body.data.source.metadata.title).toBe('Team sync');

    const [[key, object]] = [...storageMock.__state.objects.entries()];
    expect(key).toMatch(new RegExp(`^videos/${userId}/[0-9a-f-]{36}$`));
    expect(object.data.equals(buffer)).toBe(true); // byte-for-byte
    expect(object.contentType).toBe('video/mp4');

    const stored = await Upload.findOne();
    expect(stored).toMatchObject({ container: 'mp4', sizeBytes: 8192, status: 'stored', originalName: 'Team sync.mp4' });
    expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
    expect(stored.source.toString()).toBe(res.body.data.source.id);

    const job = await ProcessingJob.findById(res.body.data.job.id);
    expect(job.type).toBe('summarize_video_upload');
    // Redis gets ids only, never file data or storage keys.
    expect(queueMock.__state.added[0].data).toEqual({
      processingJobId: job.id,
      type: 'summarize_video_upload',
      input: { sourceId: res.body.data.source.id },
    });
  });

  test.each([
    ['mov', bytes.mov(), 'clip.mov', 'video/quicktime'],
    ['webm', bytes.webm(), 'clip.webm', 'video/webm'],
    ['mkv (generic MIME)', bytes.mkv(), 'clip.mkv', 'application/octet-stream'],
    ['mp4 content in a .mov file', bytes.mp4(), 'clip.mov', 'video/quicktime'],
  ])('accepts %s', async (_label, buffer, filename, type) => {
    const { auth } = await signUp();
    const res = await upload(auth, buffer, filename, type);
    expect(res.status).toBe(202);
  });

  test.each([
    ['a PNG renamed to .mp4', bytes.png(), 'photo.mp4', 'video/mp4'],
    ['an HTML/script file renamed to .mp4', bytes.html(), 'page.mp4', 'video/mp4'],
    ['an HLS playlist renamed to .mp4', bytes.m3u8(), 'list.mp4', 'video/mp4'],
    ['M4A audio', bytes.m4a(), 'song.mp4', 'video/mp4'],
    ['WebM content named .mp4', bytes.webm(), 'clip.mp4', 'video/mp4'],
  ])('rejects %s by file signature (415) and stores nothing', async (_label, buffer, filename, type) => {
    const { auth } = await signUp();
    const res = await upload(auth, buffer, filename, type);

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_VIDEO_TYPE');
    expect(storageMock.__state.objects.size).toBe(0);
    expect(await Upload.countDocuments()).toBe(0);
    expect(await Source.countDocuments()).toBe(0);
  });

  test.each([
    ['notes.pdf', 'application/pdf'],
    ['video.mp4.exe', 'application/octet-stream'],
    ['clip.avi', 'video/x-msvideo'],
    ['clip.mp4', 'image/png'],
  ])('rejects disallowed extension or MIME type %s', async (filename, type) => {
    const { auth } = await signUp();
    const res = await upload(auth, bytes.mp4(), filename, type);
    expect(res.status).toBe(415);
    expect(storageMock.__state.objects.size).toBe(0);
  });

  test('rejects files over the size limit while streaming (413) and aborts the upload', async () => {
    const { auth } = await signUp();
    const res = await upload(auth, bytes.mp4(MAX + 1024));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    expect(storageMock.__state.objects.size).toBe(0);
    expect(await Upload.countDocuments()).toBe(0);
  });

  test('rejects an oversized Content-Length before reading the body', async () => {
    const { auth } = await signUp();
    const res = await request(app)
      .post('/api/videos/uploads')
      .set(auth)
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .set('Content-Length', String(MAX * 10))
      .send('--x--');
    expect(res.status).toBe(413);
  });

  test('path traversal in the filename never reaches the storage key', async () => {
    const { auth, userId } = await signUp();
    const res = await upload(auth, bytes.mp4(), '../../../../etc/passwd.mp4');

    expect(res.status).toBe(202);
    const [key] = [...storageMock.__state.objects.keys()];
    expect(key).toMatch(new RegExp(`^videos/${userId}/[0-9a-f-]{36}$`));
    expect(key).not.toContain('..');
    expect((await Upload.findOne()).originalName).toBe('passwd.mp4');
  });

  test('requires a file', async () => {
    const { auth } = await signUp();
    const res = await request(app).post('/api/videos/uploads').set(auth).field('note', 'no file');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FILE');
  });

  test('rejects non-multipart requests', async () => {
    const { auth } = await signUp();
    const res = await request(app).post('/api/videos/uploads').set(auth).send({ file: 'base64...' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_UPLOAD');
  });

  test('explains that storage must be configured (503) instead of pretending to work', async () => {
    const { auth } = await signUp();
    storageMock.__state.configured = false;

    const res = await upload(auth, bytes.mp4());

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_NOT_CONFIGURED');
    expect(res.body.error.message).toMatch(/object storage has not been configured/);
  });

  test('an identical file from the same user reuses the existing summary and discards the copy', async () => {
    const { auth } = await signUp();
    const buffer = bytes.mp4(4096, 7);
    const first = await upload(auth, buffer);
    const second = await upload(auth, buffer, 'renamed copy.mp4');

    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.source.id).toBe(first.body.data.source.id);
    expect(storageMock.__state.objects.size).toBe(1);
    expect(storageMock.__state.deleted).toHaveLength(1);
    expect(await Upload.countDocuments()).toBe(1);
    expect(queueMock.__state.added).toHaveLength(1);
  });

  test('the same file from different users is stored separately', async () => {
    const a = await signUp();
    const b = await signUp();
    const buffer = bytes.mp4(4096, 9);
    expect((await upload(a.auth, buffer)).status).toBe(202);
    expect((await upload(b.auth, buffer)).status).toBe(202);
    expect(storageMock.__state.objects.size).toBe(2);
  });

  test('queue outage: 503 and the stored file is scheduled for immediate cleanup', async () => {
    const { auth } = await signUp();
    queueMock.__state.available = false;

    const res = await upload(auth, bytes.mp4(4096, 3));

    expect(res.status).toBe(503);
    const stored = await Upload.findOne();
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await Source.countDocuments()).toBe(0);
  });
});
