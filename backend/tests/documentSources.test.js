'use strict';

jest.mock('../src/queues/processingQueue', () => require('./helpers/queueMock'));
jest.mock('../src/services/storageService', () => {
  const mock = require('./helpers/storageMock');
  const actual = jest.requireActual('../src/services/storageService');
  return { ...mock, contentDisposition: actual.contentDisposition };
});

const request = require('supertest');
const queueMock = require('./helpers/queueMock');
const storageMock = require('./helpers/storageMock');
const docs = require('./helpers/documentBytes');
const { createApp } = require('../src/app');
const Source = require('../src/models/Source');
const Upload = require('../src/models/Upload');
const DocumentPart = require('../src/models/DocumentPart');
const ProcessingJob = require('../src/models/ProcessingJob');
const { contentDisposition } = require('../src/services/storageService');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const app = createApp();
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let counter = 0;
async function signUp() {
  counter += 1;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Doc Owner', email: `owner${counter}@example.com`, password: 'reading123' });
  return { auth: { Authorization: `Bearer ${res.body.data.accessToken}` }, userId: res.body.data.user.id };
}

async function uploadDoc(auth, { buffer = docs.pdf(counter), filename = 'Report.pdf', type = 'application/pdf' } = {}) {
  const res = await request(app).post('/api/documents/uploads').set(auth).attach('file', buffer, { filename, contentType: type });
  return res.body.data.source.id;
}

async function markExtracted(sourceId, userId, { pendingOcr = false } = {}) {
  await DocumentPart.insertMany(
    [1, 2, 3].map((page) => ({
      user: userId,
      source: sourceId,
      index: page - 1,
      page,
      headingPath: page > 1 ? ['Introduction'] : [],
      blocks: [{ kind: 'paragraph', text: `Text of page ${page}.` }],
      needsOcr: pendingOcr && page === 3,
      charCount: 15,
    }))
  );
  await Source.updateOne({ _id: sourceId }, { $set: { 'document.extractedAt': new Date(), 'document.pageCount': 3 } });
}

beforeAll(startTestDatabase);
beforeEach(() => {
  queueMock.__reset();
  storageMock.__reset();
});
afterEach(clearTestDatabase);
afterAll(stopTestDatabase);

describe('GET /api/sources/:id/original', () => {
  test('PDFs open inline for the owner, with the original filename', async () => {
    const { auth } = await signUp();
    const id = await uploadDoc(auth, { filename: 'Annual report.pdf' });

    const res = await request(app).get(`/api/sources/${id}/original`).set(auth);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.original).toMatchObject({ inline: true, filename: 'Annual report.pdf', format: 'pdf' });
    expect(storageMock.__state.signed.at(-1)).toMatchObject({ inline: true, contentType: 'application/pdf', filename: 'Annual report.pdf' });
    expect(storageMock.__state.signed.at(-1).ttlSeconds).toBeLessThanOrEqual(3600);
  });

  test('download=1 and DOCX/TXT files are always served as attachments', async () => {
    const { auth } = await signUp();
    const pdf = await uploadDoc(auth);
    await request(app).get(`/api/sources/${pdf}/original?download=1`).set(auth);
    expect(storageMock.__state.signed.at(-1).inline).toBe(false);

    const docx = await uploadDoc(auth, { buffer: docs.docx(5), filename: 'Review.docx', type: DOCX_MIME });
    const res = await request(app).get(`/api/sources/${docx}/original`).set(auth);
    expect(res.body.data.original.inline).toBe(false);
  });

  test("another user can't get a URL for someone else's document", async () => {
    const owner = await signUp();
    const intruder = await signUp();
    const id = await uploadDoc(owner.auth);

    const res = await request(app).get(`/api/sources/${id}/original`).set(intruder.auth);
    expect(res.status).toBe(404);
    expect(storageMock.__state.signed).toHaveLength(0);
  });

  test('410 once the file has been cleaned up', async () => {
    const { auth } = await signUp();
    const id = await uploadDoc(auth);
    await Upload.updateMany({}, { $set: { status: 'deleted' } });

    const res = await request(app).get(`/api/sources/${id}/original`).set(auth);
    expect(res.status).toBe(410);
    expect(res.body.error.message).toMatch(/removed after 30 days/);
  });

  test('not available for articles', async () => {
    const { auth } = await signUp();
    const created = await request(app).post('/api/articles').set(auth).send({ url: 'https://news.example.com/a' });
    const res = await request(app).get(`/api/sources/${created.body.data.source.id}/original`).set(auth);
    expect(res.status).toBe(404);
  });

  test('validates the download flag', async () => {
    const { auth } = await signUp();
    const id = await uploadDoc(auth);
    expect((await request(app).get(`/api/sources/${id}/original?download=yes`).set(auth)).status).toBe(400);
  });

  test('Content-Disposition is safe for any filename', () => {
    expect(contentDisposition('attachment', 'a"b\\c.pdf')).toBe(`attachment; filename="a_b_c.pdf"; filename*=UTF-8''a%22b%5Cc.pdf`);
    expect(contentDisposition('inline', 'Bericht – März.pdf')).toMatch(/^inline; filename="Bericht _ M_rz.pdf"; filename\*=UTF-8''/);
    expect(contentDisposition('inline')).toBe('inline');
  });
});

describe('GET /api/sources/:id/document-text', () => {
  test('returns extracted parts with page references, paginated, to the owner only', async () => {
    const owner = await signUp();
    const intruder = await signUp();
    const id = await uploadDoc(owner.auth);
    await markExtracted(id, owner.userId);

    const res = await request(app).get(`/api/sources/${id}/document-text?limit=2`).set(owner.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(res.body.data.parts.map((p) => p.page)).toEqual([1, 2]);
    expect(res.body.data.parts[1]).toMatchObject({ headingPath: ['Introduction'], blocks: [{ kind: 'paragraph', text: 'Text of page 2.' }], ocr: false });
    expect(res.body.data.parts[0].user).toBeUndefined();

    const second = await request(app).get(`/api/sources/${id}/document-text?limit=2&page=2`).set(owner.auth);
    expect(second.body.data.parts.map((p) => p.page)).toEqual([3]);

    expect((await request(app).get(`/api/sources/${id}/document-text`).set(intruder.auth)).status).toBe(404);
  });

  test('404 before extraction', async () => {
    const { auth } = await signUp();
    const id = await uploadDoc(auth);
    const res = await request(app).get(`/api/sources/${id}/document-text`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DOCUMENT_TEXT_NOT_FOUND');
  });
});

describe('retry for documents', () => {
  test('an extracted document can be retried even after its file expired (text is stored)', async () => {
    const { auth, userId } = await signUp();
    const id = await uploadDoc(auth);
    await markExtracted(id, userId);
    await Source.updateOne({ _id: id }, { $set: { status: 'failed' } });
    await Upload.updateMany({}, { $set: { status: 'deleted' } });

    const res = await request(app).post(`/api/sources/${id}/retry`).set(auth);
    expect(res.status).toBe(202);
    expect((await ProcessingJob.findById(res.body.data.job.id)).type).toBe('summarize_document');
  });

  test('a document that still needs its file (not extracted, or OCR pending) cannot be retried once it expired', async () => {
    const { auth, userId } = await signUp();
    const notExtracted = await uploadDoc(auth);
    const ocrPending = await uploadDoc(auth);
    await markExtracted(ocrPending, userId, { pendingOcr: true });
    await Source.updateMany({}, { $set: { status: 'failed' } });
    await Upload.updateMany({}, { $set: { status: 'deleted' } });

    for (const id of [notExtracted, ocrPending]) {
      const res = await request(app).post(`/api/sources/${id}/retry`).set(auth);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('UPLOAD_EXPIRED');
      expect(res.body.error.message).toMatch(/upload the document again/);
    }
  });
});

test('library filters documents by kind', async () => {
  const { auth } = await signUp();
  await uploadDoc(auth);
  await request(app).post('/api/articles').set(auth).send({ url: 'https://news.example.com/b' });
  const res = await request(app).get('/api/sources?kind=document').set(auth);
  expect(res.body.data.items).toHaveLength(1);
  expect(res.body.data.items[0]).toMatchObject({ kind: 'document', title: 'Report' });
});
