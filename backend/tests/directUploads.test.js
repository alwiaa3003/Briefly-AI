'use strict';

/**
 * Direct browser-to-storage uploads: start (presigned URL for the upload key) -> browser PUT ->
 * complete (server copy to an immutable key, verification of the copy) -> existing pipeline.
 * Storage and the queue are in-memory mocks; the "browser PUT" is storageMock.__put.
 */

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/storageService', () => require('./helpers/storageMock'));

const crypto = require('crypto');
const request = require('supertest');
const queueMock = require('./helpers/queueMock');
const storageMock = require('./helpers/storageMock');
const docs = require('./helpers/documentBytes');
const videos = require('./helpers/videoBytes');
const { createApp } = require('../src/app');
const Source = require('../src/models/Source');
const Upload = require('../src/models/Upload');
const ProcessingJob = require('../src/models/ProcessingJob');
const sourceService = require('../src/services/sourceService');
const { cleanupExpiredUploads } = require('../src/services/cleanupService');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
const DOC_MAX = Number(process.env.DOCUMENT_MAX_BYTES);
const VIDEO_MAX = Number(process.env.UPLOAD_MAX_BYTES);
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const objects = () => storageMock.__state.objects;

let counter = 0;
async function signUp() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Direct Uploader', email: `direct${counter}@example.com`, password: 'uploading123' });
  return { auth: { Authorization: `Bearer ${res.body.data.accessToken}` }, userId: res.body.data.user.id };
}

const start = (auth, body, kind = 'documents') => request(app).post(`/api/${kind}/uploads/direct`).set(auth).send(body);
const complete = (auth, id, kind = 'documents') => request(app).post(`/api/${kind}/uploads/direct/${id}/complete`).set(auth);
const cancel = (auth, id, kind = 'documents') => request(app).delete(`/api/${kind}/uploads/direct/${id}`).set(auth);

/** start + simulated browser PUT. Returns { id, key (upload key), final (immutable key), data }. */
async function startAndPut(auth, { name = 'report.pdf', data = docs.pdf(), mimeType = 'application/pdf', kind = 'documents', putData } = {}) {
  const res = await start(auth, { fileName: name, sizeBytes: data.length, mimeType }, kind);
  expect(res.status).toBe(201);
  const record = await Upload.findById(res.body.data.uploadId);
  storageMock.__put(record.uploadKey, putData || data);
  return { id: res.body.data.uploadId, key: record.uploadKey, final: record.storageKey, data, body: res.body.data };
}

/** Moves an upload's purge time into the past (its presigned URL can no longer be used). */
const urlNoLongerUsable = (id) => Upload.updateOne({ _id: id }, { $set: { uploadKeyPurgeAfter: new Date(Date.now() - 1000) } });

beforeAll(startTestDatabase);
beforeEach(() => {
  queueMock.__reset();
  storageMock.__reset();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

describe('starting a direct upload', () => {
  test('requires authentication', async () => {
    expect((await start({}, { fileName: 'a.pdf', sizeBytes: 10, mimeType: 'application/pdf' })).status).toBe(401);
  });

  test('returns a short-lived presigned PUT for a server-chosen upload key; the final key is never presigned', async () => {
    const { auth, userId } = await signUp();
    const data = docs.pdf();
    const res = await start(auth, { fileName: '../../etc/Quarterly report.pdf', sizeBytes: data.length, mimeType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { uploadId, upload, maxBytes } = res.body.data;
    expect(upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment' } });
    expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(maxBytes).toBe(DOC_MAX);
    // Nothing secret in the response: no storage keys, no credentials.
    expect(JSON.stringify(res.body)).not.toMatch(/secret|accessKey|storageKey|uploadKey/i);

    const record = await Upload.findById(uploadId);
    expect(record).toMatchObject({ status: 'pending', method: 'direct', kind: 'document', container: 'pdf', sizeBytes: data.length });
    expect(record.originalName).toBe('Quarterly report.pdf'); // path parts stripped, never used in a key
    expect(record.storageKey.startsWith(`documents/${userId}/`)).toBe(true);
    expect(record.uploadKey.startsWith(`documents/${userId}/upload-`)).toBe(true);
    expect(record.uploadKey).not.toBe(record.storageKey);
    expect(storageMock.__state.presigned).toEqual([
      expect.objectContaining({ key: record.uploadKey, contentType: 'application/pdf', contentLength: data.length }),
    ]);
    expect(res.body.data.upload.url).toContain(record.uploadKey);
    expect(res.body.data.upload.url).not.toContain(record.storageKey);
    // The upload key is swept only after the URL has expired (plus grace for transfers in flight).
    expect(record.uploadKeyPurgeAfter.getTime()).toBeGreaterThan(new Date(upload.expiresAt).getTime());
  });

  test.each([
    ['an unsupported extension', { fileName: 'tool.exe', sizeBytes: 100, mimeType: 'application/octet-stream' }, 415, 'UNSUPPORTED_DOCUMENT_TYPE'],
    ['a mismatching MIME type', { fileName: 'report.pdf', sizeBytes: 100, mimeType: 'image/png' }, 415, 'UNSUPPORTED_DOCUMENT_TYPE'],
    ['an empty file', { fileName: 'report.pdf', sizeBytes: 0, mimeType: 'application/pdf' }, 400, 'EMPTY_FILE'],
    ['an oversized file', { fileName: 'report.pdf', sizeBytes: DOC_MAX + 1, mimeType: 'application/pdf' }, 413, 'FILE_TOO_LARGE'],
    ['a non-integer size', { fileName: 'report.pdf', sizeBytes: 10.5, mimeType: 'application/pdf' }, 400, 'VALIDATION_ERROR'],
    ['a client-chosen storage key', { fileName: 'report.pdf', sizeBytes: 10, mimeType: 'application/pdf', storageKey: 'documents/other/x' }, 400, 'VALIDATION_ERROR'],
  ])('rejects %s', async (_label, body, status, code) => {
    const { auth } = await signUp();
    const res = await start(auth, body);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(await Upload.countDocuments()).toBe(0);
    expect(storageMock.__state.presigned).toHaveLength(0);
  });

  test('applies the video policy and limit on the video endpoint', async () => {
    const { auth } = await signUp();
    expect((await start(auth, { fileName: 'talk.mp4', sizeBytes: VIDEO_MAX + 1, mimeType: 'video/mp4' }, 'videos')).body.error.code).toBe('FILE_TOO_LARGE');
    expect((await start(auth, { fileName: 'talk.pdf', sizeBytes: 100, mimeType: 'application/pdf' }, 'videos')).status).toBe(415);
  });

  test('limits uploads started but not completed per user', async () => {
    const { auth } = await signUp();
    const body = { fileName: 'r.pdf', sizeBytes: 100, mimeType: 'application/pdf' };
    for (let i = 0; i < 3; i += 1) expect((await start(auth, body)).status).toBe(201);
    const res = await start(auth, body);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_PENDING_UPLOADS');
  });

  test('is unavailable when storage is not configured', async () => {
    const { auth } = await signUp();
    storageMock.__state.configured = false;
    const res = await start(auth, { fileName: 'r.pdf', sizeBytes: 100, mimeType: 'application/pdf' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  test('the upload config advertises direct uploads', async () => {
    const { auth } = await signUp();
    expect((await request(app).get('/api/documents/uploads/config').set(auth)).body.data.uploads.uploadMethod).toBe('direct');
    expect((await request(app).get('/api/videos/uploads/config').set(auth)).body.data.uploads.uploadMethod).toBe('direct');
  });
});

describe('completing a direct upload', () => {
  test('copies to the immutable key, verifies the copy, queues the pipeline on it, then removes the upload object', async () => {
    const { auth, userId } = await signUp();
    const { id, key, final, data } = await startAndPut(auth);

    const res = await complete(auth, id);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ duplicate: false, source: { kind: 'document', status: 'queued' } });

    const upload = await Upload.findById(id);
    expect(upload).toMatchObject({ status: 'stored', storageKey: final, sha256: sha256(data), sizeBytes: data.length, outcome: 'created' });
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000); // retention, not the pending deadline
    const source = await Source.findById(res.body.data.source.id);
    expect(source.normalizedUrl).toBe(`upload:${sha256(data)}`);
    expect(source.user.toString()).toBe(userId);
    expect(source.upload.toString()).toBe(id);
    expect(queueMock.__state.added).toHaveLength(1);
    expect(queueMock.__state.added[0].type).toBe('summarize_document');

    expect(storageMock.__state.copies).toEqual([{ from: key, to: final }]);
    expect(storageMock.__state.reads).toEqual([final]); // the copy is what was verified
    expect(objects().get(final).data.equals(data)).toBe(true);
    expect(objects().has(key)).toBe(false); // upload object removed after success
  });

  test.each([
    ['DOCX', 'notes.docx', docs.docx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['TXT', 'notes.txt', docs.txt(), 'text/plain', 'txt'],
  ])('%s documents go through the same pipeline', async (_label, name, data, mimeType, format) => {
    const { auth } = await signUp();
    const { id } = await startAndPut(auth, { name, data, mimeType });
    const res = await complete(auth, id);
    expect(res.status).toBe(202);
    expect((await Source.findById(res.body.data.source.id)).document.format).toBe(format);
  });

  test('uploaded videos create a video source that reads the immutable key', async () => {
    const { auth } = await signUp();
    const data = videos.mp4(8192, 7);
    const { id, final } = await startAndPut(auth, { name: 'Team sync.mp4', data, mimeType: 'video/mp4', kind: 'videos' });
    const res = await complete(auth, id, 'videos');
    expect(res.status).toBe(202);
    const source = await Source.findById(res.body.data.source.id);
    expect(source).toMatchObject({ kind: 'video', video: { platform: 'upload' } });
    expect(await Upload.findById(source.upload)).toMatchObject({ status: 'stored', container: 'mp4', storageKey: final });
    expect(queueMock.__state.added[0].type).toBe('summarize_video_upload');
  });

  test('before the bytes have arrived it reports so and stays completable', async () => {
    const { auth } = await signUp();
    const data = docs.pdf();
    const started = await start(auth, { fileName: 'r.pdf', sizeBytes: data.length, mimeType: 'application/pdf' });
    const id = started.body.data.uploadId;

    const early = await complete(auth, id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('UPLOAD_NOT_RECEIVED');
    expect((await Upload.findById(id)).status).toBe('pending');
    expect(storageMock.__state.copies).toHaveLength(0);

    storageMock.__put((await Upload.findById(id)).uploadKey, data);
    expect((await complete(auth, id)).status).toBe(202);
  });

  test('a repeated completion returns the same source without a second job or copy', async () => {
    const { auth } = await signUp();
    const { id } = await startAndPut(auth);
    const first = await complete(auth, id);
    const second = await complete(auth, id);
    expect(second.status).toBe(202);
    expect(second.body.data.source.id).toBe(first.body.data.source.id);
    expect(queueMock.__state.added).toHaveLength(1);
    expect(await Source.countDocuments()).toBe(1);
    expect(storageMock.__state.copies).toHaveLength(1);
    expect(storageMock.__state.reads).toHaveLength(1);
  });

  test('concurrent completions copy and verify once', async () => {
    const { auth } = await signUp();
    const { id } = await startAndPut(auth);
    const results = await Promise.all([complete(auth, id), complete(auth, id), complete(auth, id)]);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 202).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 202 || s === 409)).toBe(true);
    expect(await Source.countDocuments()).toBe(1);
    expect(queueMock.__state.added).toHaveLength(1);
    expect(storageMock.__state.copies).toHaveLength(1);
  });

  test("users cannot complete or cancel another user's upload", async () => {
    const owner = await signUp();
    const other = await signUp();
    const { id } = await startAndPut(owner.auth);
    expect((await complete(other.auth, id)).status).toBe(404);
    expect((await cancel(other.auth, id)).status).toBe(404);
    expect((await Upload.findById(id)).status).toBe('pending');
    expect(storageMock.__state.copies).toHaveLength(0);
  });

  test('an id of the wrong kind or malformed is not found / invalid', async () => {
    const { auth } = await signUp();
    const { id } = await startAndPut(auth);
    expect((await complete(auth, id, 'videos')).status).toBe(404);
    expect((await complete(auth, 'not-an-id')).status).toBe(400);
  });

  test('a file of a different size than announced is rejected and deleted', async () => {
    const { auth } = await signUp();
    const { id, key } = await startAndPut(auth, { putData: Buffer.concat([docs.pdf(), Buffer.from('extra')]) });
    const res = await complete(auth, id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UPLOAD_MISMATCH');
    expect(objects().has(key)).toBe(false);
    expect(['rejected', 'deleted']).toContain((await Upload.findById(id)).status);
    expect(await Source.countDocuments()).toBe(0);
  });

  test('content that is not the declared type is rejected; both objects are deleted', async () => {
    const { auth } = await signUp();
    const { id, key, final } = await startAndPut(auth, { name: 'invoice.pdf', data: docs.exe(), mimeType: 'application/pdf' });
    const res = await complete(auth, id);
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_DOCUMENT_TYPE');
    expect(objects().has(key)).toBe(false);
    expect(objects().has(final)).toBe(false);
    expect(await Source.countDocuments()).toBe(0);
    expect((await complete(auth, id)).body.error.code).toBe('UPLOAD_EXPIRED');
  });

  test('an expired upload is rejected and its objects deleted', async () => {
    const { auth } = await signUp();
    const { id, key } = await startAndPut(auth);
    await Upload.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await complete(auth, id);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('UPLOAD_EXPIRED');
    expect(objects().has(key)).toBe(false);
  });

  test('the same file as an existing summary opens it and discards the new copy', async () => {
    const { auth } = await signUp();
    const data = docs.pdf();
    const first = await startAndPut(auth, { data });
    const created = await complete(auth, first.id);

    const second = await startAndPut(auth, { data });
    const res = await complete(auth, second.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ duplicate: true, source: { id: created.body.data.source.id } });
    expect(objects().has(second.key)).toBe(false);
    expect(objects().has(second.final)).toBe(false);
    expect(objects().has(first.final)).toBe(true); // the existing summary's file is untouched
    expect(await Upload.findById(second.id)).toMatchObject({ status: 'deleted', outcome: 'existing' });
    expect((await complete(auth, second.id)).body.data.duplicate).toBe(true);
    expect(queueMock.__state.added).toHaveLength(1);
  });

  test('with the job queue down nothing is lost: completing again later succeeds', async () => {
    const { auth } = await signUp();
    const { id } = await startAndPut(auth);
    queueMock.__state.available = false;
    expect((await complete(auth, id)).body.error.code).toBe('QUEUE_UNAVAILABLE');
    queueMock.__state.available = true;
    const res = await complete(auth, id);
    expect(res.status).toBe(202);
    expect(await ProcessingJob.countDocuments()).toBe(1);
  });
});

describe('presigned URL reuse', () => {
  test('after completion, re-uploading through the URL cannot change what is processed', async () => {
    const { auth } = await signUp();
    const { id, key, final, data } = await startAndPut(auth);
    expect((await complete(auth, id)).status).toBe(202);

    // The URL is still valid for a while: the user PUTs a different file of the same size and type.
    const replacement = docs.exe();
    const swapped = Buffer.concat([replacement, Buffer.alloc(data.length - replacement.length)]);
    storageMock.__put(key, swapped);

    // Processing reads the immutable key, which still holds the verified bytes.
    const upload = await Upload.findById(id);
    expect(upload.storageKey).toBe(final);
    expect(objects().get(final).data.equals(data)).toBe(true);
    expect(sha256(objects().get(final).data)).toBe(upload.sha256);

    // Once the URL can no longer be used, the sweep removes the re-uploaded object, not the verified copy.
    expect((await cleanupExpiredUploads()).purged).toBe(0); // not yet: the URL may still be in use
    expect(objects().has(key)).toBe(true);
    await urlNoLongerUsable(id);
    expect(await cleanupExpiredUploads()).toMatchObject({ purged: 1, failed: 0 });
    expect(objects().has(key)).toBe(false);
    expect(objects().get(final).data.equals(data)).toBe(true);
    expect((await Upload.findById(id)).uploadKeyPurgedAt).toBeInstanceOf(Date);
    // A second run does nothing more.
    expect((await cleanupExpiredUploads()).purged).toBe(0);
  });

  test('after cancellation, a re-upload through the URL is removed once the URL expires', async () => {
    const { auth } = await signUp();
    const { id, key, final } = await startAndPut(auth);
    expect((await cancel(auth, id)).status).toBe(204);
    expect(objects().has(key)).toBe(false);

    storageMock.__put(key, docs.pdf()); // the URL is still valid for a while
    await urlNoLongerUsable(id);
    expect((await cleanupExpiredUploads()).purged).toBe(1);
    expect(objects().has(key)).toBe(false);
    expect(objects().has(final)).toBe(false);
  });

  test('after a rejection, a re-upload through the URL is removed once the URL expires', async () => {
    const { auth } = await signUp();
    const { id, key } = await startAndPut(auth, { name: 'invoice.pdf', data: docs.exe(), mimeType: 'application/pdf' });
    expect((await complete(auth, id)).status).toBe(415);
    storageMock.__put(key, docs.exe());
    await urlNoLongerUsable(id);
    expect((await cleanupExpiredUploads()).purged).toBe(1);
    expect(objects().has(key)).toBe(false);
  });

  test('after a duplicate, a re-upload through the URL is removed once the URL expires', async () => {
    const { auth } = await signUp();
    const data = docs.pdf();
    const first = await startAndPut(auth, { data });
    await complete(auth, first.id);
    const second = await startAndPut(auth, { data });
    await complete(auth, second.id);
    storageMock.__put(second.key, data);
    await urlNoLongerUsable(second.id);
    await cleanupExpiredUploads();
    expect(objects().has(second.key)).toBe(false);
    expect(objects().has(first.final)).toBe(true);
  });

  test('abandoned uploads: cleanup after expiry deletes both keys; the sweep leaves pending uploads alone', async () => {
    const { auth } = await signUp();
    const abandoned = await startAndPut(auth);
    const active = await startAndPut(auth, { data: Buffer.concat([docs.pdf(), Buffer.from('active')]) });
    // `active` is past its purge time but still pending (completable): its upload object is the only copy.
    await urlNoLongerUsable(active.id);
    await Upload.updateOne({ _id: abandoned.id }, { $set: { expiresAt: new Date(Date.now() - 1000), uploadKeyPurgeAfter: new Date(Date.now() - 1000) } });

    const result = await cleanupExpiredUploads();
    expect(result.deleted).toBe(1);
    expect(objects().has(abandoned.key)).toBe(false);
    expect((await Upload.findById(abandoned.id)).status).toBe('deleted');
    expect(objects().has(active.key)).toBe(true);
    expect((await Upload.findById(active.id)).status).toBe('pending');
    // The deleted upload's key is swept too (idempotent; nothing left behind).
    expect(objects().has(abandoned.final)).toBe(false);
  });
});

describe('failures during completion', () => {
  test('copy failure: 503, nothing deleted from the upload, completable again', async () => {
    const { auth } = await signUp();
    const { id, key, final, data } = await startAndPut(auth);
    storageMock.__state.failCopy = true;

    const res = await complete(auth, id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect((await Upload.findById(id)).status).toBe('pending');
    expect(objects().get(key).data.equals(data)).toBe(true); // the user's upload is untouched
    expect(objects().has(final)).toBe(false);
    expect(await Source.countDocuments()).toBe(0);

    storageMock.__state.failCopy = false;
    expect((await complete(auth, id)).status).toBe(202);
  });

  test('a corrupted copy (size mismatch) is deleted, the upload kept, and completion can be retried', async () => {
    const { auth } = await signUp();
    const { id, key, final } = await startAndPut(auth);
    storageMock.__state.copyTransform = (bytes) => bytes.subarray(0, bytes.length - 10);

    const res = await complete(auth, id);
    expect(res.status).toBe(503);
    expect(objects().has(final)).toBe(false); // unverified copy removed
    expect(objects().has(key)).toBe(true); // the only copy of the user's bytes is kept
    expect((await Upload.findById(id)).status).toBe('pending');

    storageMock.__state.copyTransform = null;
    expect((await complete(auth, id)).status).toBe(202);
  });

  test('reading the copy fails: the copy is deleted, the upload kept, completion can be retried', async () => {
    const { auth } = await signUp();
    const { id, key, final } = await startAndPut(auth);
    storageMock.__state.failReadKeys.add(final);

    expect((await complete(auth, id)).status).toBe(503);
    expect(objects().has(final)).toBe(false);
    expect(objects().has(key)).toBe(true);
    expect((await Upload.findById(id)).status).toBe('pending');

    storageMock.__state.failReadKeys.clear();
    expect((await complete(auth, id)).status).toBe(202);
  });

  test('the database update fails after verification: nothing is lost, the next completion succeeds', async () => {
    const { auth } = await signUp();
    const { id, key } = await startAndPut(auth);
    jest.spyOn(sourceService, 'submitUploadedDocument').mockRejectedValueOnce(new Error('database unavailable'));

    const res = await complete(auth, id);
    expect(res.status).toBe(500);
    expect((await Upload.findById(id)).status).toBe('pending');
    expect(objects().has(key)).toBe(true); // the upload object is only deleted after a stored record exists

    const retry = await complete(auth, id);
    expect(retry.status).toBe(202);
    expect(await Source.countDocuments()).toBe(1);
  });

  test('deleting the upload object fails after success: completion succeeds, the verified copy is never deleted, the sweep retries', async () => {
    const { auth } = await signUp();
    const { id, key, final, data } = await startAndPut(auth);
    storageMock.__state.failDeleteKeys.add(key);

    const res = await complete(auth, id);
    expect(res.status).toBe(202);
    expect(objects().has(key)).toBe(true);
    expect(objects().get(final).data.equals(data)).toBe(true);
    expect(storageMock.__state.deleted).not.toContain(final);

    await urlNoLongerUsable(id);
    expect(await cleanupExpiredUploads()).toMatchObject({ purged: 0, failed: 1 }); // still failing: retried next run
    expect((await Upload.findById(id)).uploadKeyPurgedAt).toBeNull();
    storageMock.__state.failDeleteKeys.clear();
    expect((await cleanupExpiredUploads()).purged).toBe(1);
    expect(objects().has(key)).toBe(false);
    expect(objects().get(final).data.equals(data)).toBe(true);
  });

  test('a failed deletion after rejection leaves the record for the cleanup to finish', async () => {
    const { auth } = await signUp();
    const { id, key } = await startAndPut(auth, { name: 'invoice.pdf', data: docs.exe(), mimeType: 'application/pdf' });
    storageMock.__state.failDeleteKeys.add(key);
    expect((await complete(auth, id)).status).toBe(415);
    expect((await Upload.findById(id)).status).toBe('rejected');

    storageMock.__state.failDeleteKeys.clear();
    await cleanupExpiredUploads();
    expect((await Upload.findById(id)).status).toBe('deleted');
    expect(objects().has(key)).toBe(false);
  });

  test('a transient storage failure before the copy leaves the upload completable', async () => {
    const { auth } = await signUp();
    const { id } = await startAndPut(auth);
    storageMock.__state.failHead = true;
    const res = await complete(auth, id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect((await Upload.findById(id)).status).toBe('pending');
    storageMock.__state.failHead = false;
    expect((await complete(auth, id)).status).toBe(202);
  });

  test('legacy pending uploads without an upload key cannot be completed', async () => {
    const { auth, userId } = await signUp();
    const legacy = await Upload.create({
      user: userId,
      storageKey: `documents/${userId}/legacy`,
      originalName: 'old.pdf',
      mimeType: 'application/pdf',
      container: 'pdf',
      sizeBytes: 10,
      status: 'pending',
      method: 'direct',
      kind: 'document',
      expiresAt: new Date(Date.now() + 60000),
    });
    const res = await complete(auth, legacy.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UPLOAD_EXPIRED');
    expect(storageMock.__state.copies).toHaveLength(0);
  });
});

describe('cancelling and cleaning up', () => {
  test('cancel removes the reservation and any uploaded bytes; it cannot be completed afterwards', async () => {
    const { auth } = await signUp();
    const { id, key } = await startAndPut(auth);
    expect((await cancel(auth, id)).status).toBe(204);
    expect(objects().has(key)).toBe(false);
    expect((await Upload.findById(id)).status).toBe('deleted');
    expect((await complete(auth, id)).body.error.code).toBe('UPLOAD_EXPIRED');
  });

  test('a completed upload cannot be cancelled (its file belongs to a summary now)', async () => {
    const { auth } = await signUp();
    const { id, final } = await startAndPut(auth);
    await complete(auth, id);
    const res = await cancel(auth, id);
    expect(res.status).toBe(409);
    expect(storageMock.__state.deleted).not.toContain(final);
  });

  test('an upload being verified cannot be cancelled underneath the verification', async () => {
    const { auth } = await signUp();
    const { id, key } = await startAndPut(auth);
    await Upload.updateOne({ _id: id }, { $set: { status: 'verifying', verifyingAt: new Date() } });
    const res = await cancel(auth, id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UPLOAD_IN_PROGRESS');
    expect(objects().has(key)).toBe(true);
  });

  test('cleanup removes abandoned and rejected uploads only, never stored files within retention', async () => {
    const { auth } = await signUp();
    const abandoned = await startAndPut(auth, { data: docs.pdf(4096) });
    const fresh = await startAndPut(auth, { data: Buffer.concat([docs.pdf(), Buffer.from('fresh')]) });
    const kept = await startAndPut(auth, { data: Buffer.concat([docs.pdf(), Buffer.from('kept')]) });
    await complete(auth, kept.id);
    const past = new Date(Date.now() - 1000);
    await Upload.updateOne({ _id: abandoned.id }, { $set: { expiresAt: past } });
    await Upload.create({
      user: (await Upload.findById(fresh.id)).user,
      storageKey: 'documents/x/rejected-left-behind',
      originalName: 'r.pdf',
      mimeType: 'application/pdf',
      container: 'pdf',
      sizeBytes: 10,
      status: 'rejected',
      method: 'direct',
      kind: 'document',
      expiresAt: past,
    });

    const result = await cleanupExpiredUploads();
    expect(result).toMatchObject({ deleted: 2, failed: 0 });
    expect(objects().has(abandoned.key)).toBe(false);
    expect(storageMock.__state.deleted).toEqual(expect.arrayContaining([abandoned.key, abandoned.final, 'documents/x/rejected-left-behind']));
    expect((await Upload.findById(fresh.id)).status).toBe('pending'); // still within its deadline
    expect(objects().has(fresh.key)).toBe(true);
    expect((await Upload.findById(kept.id)).status).toBe('stored'); // within retention
    expect(objects().has(kept.final)).toBe(true);
  });

  test('cleanup leaves a verification in progress alone', async () => {
    const { auth } = await signUp();
    const { id, key } = await startAndPut(auth);
    await Upload.updateOne({ _id: id }, { $set: { status: 'verifying', verifyingAt: new Date(), expiresAt: new Date(Date.now() - 1000) } });
    await cleanupExpiredUploads();
    expect(storageMock.__state.deleted).not.toContain(key);
  });
});

describe('streamed uploads still work', () => {
  test('the multipart endpoint stores and queues as before (single key, no upload key)', async () => {
    const { auth } = await signUp();
    const res = await request(app)
      .post('/api/documents/uploads')
      .set(auth)
      .attach('file', docs.pdf(), { filename: 'legacy.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(202);
    const upload = await Upload.findOne({ method: 'proxy' });
    expect(upload).toMatchObject({ status: 'stored', uploadKey: null });
    // The sweep never touches proxy uploads.
    await Upload.updateOne({ _id: upload._id }, { $set: { uploadKeyPurgeAfter: new Date(0) } });
    await cleanupExpiredUploads();
    expect(objects().has(upload.storageKey)).toBe(true);
  });
});
