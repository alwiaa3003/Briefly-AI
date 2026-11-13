'use strict';

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/storageService', () => require('./helpers/storageMock'));

const request = require('supertest');
const queueMock = require('./helpers/queueMock');
const storageMock = require('./helpers/storageMock');
const docs = require('./helpers/documentBytes');
const { createApp } = require('../src/app');
const Source = require('../src/models/Source');
const Upload = require('../src/models/Upload');
const ProcessingJob = require('../src/models/ProcessingJob');
const { detectDocumentFormat, looksLikeText } = require('../src/utils/documentFile');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
const MAX = Number(process.env.DOCUMENT_MAX_BYTES);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let counter = 0;
async function signUp() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Doc Reader', email: `doc${counter}@example.com`, password: 'reading123' });
  return { auth: { Authorization: `Bearer ${res.body.data.accessToken}` }, userId: res.body.data.user.id };
}

const upload = (auth, buffer, filename, contentType) =>
  request(app).post('/api/documents/uploads').set(auth).attach('file', buffer, { filename, contentType });

beforeAll(startTestDatabase);
beforeEach(() => {
  queueMock.__reset();
  storageMock.__reset();
});
afterEach(clearTestDatabase);
afterAll(stopTestDatabase);

describe('document signatures', () => {
  test.each([
    [docs.pdf(), 'pdf', 'pdf'],
    [docs.pdfWithPreamble(), 'pdf', 'pdf'],
    [docs.docx(), 'docx', 'docx'],
    [docs.txt(), 'txt', 'txt'],
    [docs.utf16(), 'txt', 'txt'],
    [docs.png(), 'pdf', null],
    [docs.exe(), 'txt', null],
    [docs.legacyDoc(), 'docx', null],
    [docs.binaryText(), 'txt', null],
  ])('detects %#', (buffer, expected, result) => {
    expect(detectDocumentFormat(buffer, expected)).toBe(result);
  });

  test('text heuristics', () => {
    expect(looksLikeText(Buffer.from('plain ascii\nwith lines'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
    expect(looksLikeText(Buffer.alloc(0))).toBe(false);
  });
});

describe('GET /api/documents/uploads/config', () => {
  test('reports limits and whether uploads are enabled', async () => {
    const { auth } = await signUp();
    const res = await request(app).get('/api/documents/uploads/config').set(auth);
    expect(res.body.data.uploads).toMatchObject({ enabled: true, maxBytes: MAX, acceptedExtensions: ['.pdf', '.docx', '.txt'] });

    storageMock.__state.configured = false;
    expect((await request(app).get('/api/documents/uploads/config').set(auth)).body.data.uploads.enabled).toBe(false);
  });
});

describe('POST /api/documents/uploads', () => {
  test('requires authentication', async () => {
    const res = await request(app).post('/api/documents/uploads').attach('file', docs.pdf(), 'a.pdf');
    expect(res.status).toBe(401);
  });

  test.each([
    ['PDF', () => docs.pdf(1), 'Annual report 2025.pdf', 'application/pdf', 'pdf', 'application/pdf'],
    ['DOCX', () => docs.docx(1), 'Quarterly review.docx', DOCX_MIME, 'docx', DOCX_MIME],
    ['TXT', () => docs.txt(), 'meeting-notes.txt', 'text/plain', 'txt', 'text/plain; charset=utf-8'],
    ['UTF-16 TXT', () => docs.utf16(), 'notes.txt', 'text/plain', 'txt', 'text/plain; charset=utf-8'],
    ['PDF with generic MIME', () => docs.pdf(2), 'scan.pdf', 'application/octet-stream', 'pdf', 'application/pdf'],
  ])('streams a valid %s to storage and queues summarize_document', async (_label, make, filename, type, format, stored) => {
    const { auth, userId } = await signUp();
    const buffer = make();
    const res = await upload(auth, buffer, filename, type);

    expect(res.status).toBe(202);
    expect(res.body.data.source).toMatchObject({ kind: 'document', status: 'queued', submittedUrl: null, document: { format } });

    const [[key, object]] = [...storageMock.__state.objects.entries()];
    expect(key).toMatch(new RegExp(`^documents/${userId}/[0-9a-f-]{36}$`));
    expect(object.data.equals(buffer)).toBe(true);
    expect(object.contentType).toBe(stored);

    const record = await Upload.findOne();
    expect(record).toMatchObject({ container: format, originalName: filename, status: 'stored' });
    // Documents are kept for DOCUMENT_RETENTION_DAYS (default 30).
    expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
    expect((await ProcessingJob.findById(res.body.data.job.id)).type).toBe('summarize_document');
    expect(queueMock.__state.added[0].data.input).toEqual({ sourceId: res.body.data.source.id });
  });

  test.each([
    ['a PNG renamed to .pdf', docs.png(), 'photo.pdf', 'application/pdf'],
    ['a ZIP/DOCX renamed to .pdf', docs.docx(), 'file.pdf', 'application/pdf'],
    ['a PDF renamed to .docx', docs.pdf(), 'file.docx', DOCX_MIME],
    ['an executable renamed to .txt', docs.exe(), 'readme.txt', 'text/plain'],
    ['binary data renamed to .txt', docs.binaryText(), 'data.txt', 'text/plain'],
    ['a legacy .doc renamed to .docx', docs.legacyDoc(), 'old.docx', DOCX_MIME],
  ])('rejects %s by file signature (415) and stores nothing', async (_label, buffer, filename, type) => {
    const { auth } = await signUp();
    const res = await upload(auth, buffer, filename, type);

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_DOCUMENT_TYPE');
    expect(storageMock.__state.objects.size).toBe(0);
    expect(await Upload.countDocuments()).toBe(0);
    expect(await Source.countDocuments()).toBe(0);
  });

  test.each([
    ['legacy.doc', 'application/msword'],
    ['macro.docm', 'application/vnd.ms-word.document.macroEnabled.12'],
    ['template.dotx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['page.html', 'text/html'],
    ['report.pdf', 'image/png'],
  ])('rejects disallowed extension or MIME type %s', async (filename, type) => {
    const { auth } = await signUp();
    const res = await upload(auth, docs.pdf(), filename, type);
    expect(res.status).toBe(415);
    expect(storageMock.__state.objects.size).toBe(0);
  });

  test('rejects files over DOCUMENT_MAX_BYTES while streaming (413)', async () => {
    const { auth } = await signUp();
    const res = await upload(auth, docs.pdf(0, MAX + 4096), 'huge.pdf', 'application/pdf');
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    expect(storageMock.__state.objects.size).toBe(0);
  });

  test('path traversal in the filename never reaches the storage key', async () => {
    const { auth, userId } = await signUp();
    const res = await upload(auth, docs.pdf(), '..\\..\\windows\\system32\\evil.pdf', 'application/pdf');
    expect(res.status).toBe(202);
    const [key] = [...storageMock.__state.objects.keys()];
    expect(key).toMatch(new RegExp(`^documents/${userId}/[0-9a-f-]{36}$`));
    expect((await Upload.findOne()).originalName).toBe('evil.pdf');
  });

  test('identical files reuse the existing summary; the copy is deleted', async () => {
    const { auth } = await signUp();
    const first = await upload(auth, docs.pdf(77), 'a.pdf', 'application/pdf');
    const second = await upload(auth, docs.pdf(77), 'renamed.pdf', 'application/pdf');

    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.source.id).toBe(first.body.data.source.id);
    expect(storageMock.__state.objects.size).toBe(1);
    expect(queueMock.__state.added).toHaveLength(1);
  });

  test('503 with setup instructions when storage is not configured', async () => {
    const { auth } = await signUp();
    storageMock.__state.configured = false;
    const res = await upload(auth, docs.pdf(), 'a.pdf', 'application/pdf');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  test('video uploads keep using the video policy', async () => {
    const { auth } = await signUp();
    const res = await request(app)
      .post('/api/videos/uploads')
      .set(auth)
      .attach('file', docs.pdf(), { filename: 'notes.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_VIDEO_TYPE');
  });
});

describe('storage consistency', () => {
  test('a database failure after the file reached storage deletes the stored object (no orphans)', async () => {
    const { auth } = await signUp();
    const spy = jest.spyOn(Upload, 'create').mockRejectedValueOnce(new Error('database unavailable'));
    try {
      const res = await upload(auth, docs.pdf(77), 'report.pdf', 'application/pdf');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toMatch(/database unavailable/);
    } finally {
      spy.mockRestore();
    }
    expect(storageMock.__state.objects.size).toBe(0);
    expect(storageMock.__state.deleted).toHaveLength(1);
    expect(await Source.countDocuments()).toBe(0);
  });
});
