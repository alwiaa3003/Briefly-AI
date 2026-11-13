'use strict';

/**
 * summarize_document through the real processor. Processing service and storage
 * are mocked. Test limits (tests/setup/testEnv.js): single pass <= 5000 chars,
 * chunks of 5000 chars, at most 3 OCR pages, OCR batches of 2.
 */

jest.mock('../src/services/storageService', () => require('./helpers/storageMock'));
jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return {
    ...actual,
    extractDocument: jest.fn(),
    ocrDocumentPages: jest.fn(),
    summarizeDocumentChunk: jest.fn(),
    summarizeDocument: jest.fn(),
  };
});

const mongoose = require('mongoose');
const { UnrecoverableError } = require('bullmq');
const processingClient = require('../src/services/processingClient');
const { ProcessingServiceError } = processingClient;
const storageMock = require('./helpers/storageMock');
const Source = require('../src/models/Source');
const Summary = require('../src/models/Summary');
const Upload = require('../src/models/Upload');
const ProcessingJob = require('../src/models/ProcessingJob');
const DocumentPart = require('../src/models/DocumentPart');
const DocumentChunk = require('../src/models/DocumentChunk');
const { processJob } = require('../src/workers/processor');
const { planChunks, allowedReferences } = require('../src/workers/handlers/documentSummaryHandler');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

beforeAll(startTestDatabase);
beforeEach(() => storageMock.__reset());
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

function pdfPart(page, text, extra = {}) {
  return {
    index: page - 1,
    page,
    heading_path: page > 1 ? ['Introduction'] : [],
    blocks: text ? [{ kind: 'paragraph', text, level: null }] : [],
    needs_ocr: false,
    char_count: text ? text.length : 0,
    ...extra,
  };
}

function extraction(parts, overrides = {}) {
  return {
    format: 'pdf',
    metadata: { title: 'Urban Heat Report', author: 'Example Institute', created: '2025-03-01' },
    page_count: parts.length,
    pages_processed: parts.length,
    char_count: parts.reduce((n, p) => n + p.char_count, 0),
    word_count: 500,
    parts,
    ocr_pages: parts.filter((p) => p.needs_ocr).map((p) => p.page),
    truncated: false,
    warnings: [],
    ...overrides,
  };
}

const r = (text, pages = [], section = null) => ({ text, pages, section });
const SUMMARY = {
  summary: {
    title: 'Urban Heat Report',
    overview: 'The report shows how trees cool cities and why canopy is unevenly shared between districts.',
    sections: [{ heading: 'Cooling', content: 'Shade and evapotranspiration lower temperatures.' }],
    section_breakdown: [{ title: 'Introduction', summary: 'Why trees matter.', pages: [1], section: null }],
    key_takeaways: [r('Trees cool cities.', [1]), r('Canopy is unequal.', [2]), r('Fund maintenance.', [3])],
    concepts: [{ term: 'Canopy', explanation: 'Tree cover.', pages: [2], section: null }],
    facts: [{ statement: 'Canopy is 31% in rich districts.', pages: [2], section: null }],
    main_arguments: [r('Protect mature trees.', [3])],
  },
  model: 'gemini-test',
  prompt_version: 'document-summary-v1',
  mode: 'direct',
  input_characters: 1000,
  references_discarded: 1,
  merge_rounds: 0,
  usage: { input_tokens: 800, output_tokens: 300 },
};
const NOTES = { sections: [], key_points: [r('A point.', [1])], facts: [], definitions: [], arguments: [] };

async function createDocumentSource({ format = 'pdf', expiresAt = new Date(Date.now() + 86400000) } = {}) {
  const user = new mongoose.Types.ObjectId();
  const upload = await Upload.create({
    user,
    storageKey: `documents/${user}/doc`,
    originalName: 'urban-heat.pdf',
    mimeType: 'application/pdf',
    container: format,
    sizeBytes: 5000,
    sha256: 'b'.repeat(64),
    expiresAt,
  });
  const source = await Source.create({
    user,
    kind: 'document',
    normalizedUrl: `upload:${'b'.repeat(64)}`,
    metadata: { title: 'urban heat' },
    document: { format },
    upload: upload._id,
  });
  const job = await ProcessingJob.create({ user, type: 'summarize_document', source: source._id, input: { sourceId: source.id }, maxAttempts: 3 });
  return { source, job, upload, user };
}

const bullJob = (job, { attemptsMade = 0, attempts = 3 } = {}) => ({
  data: { processingJobId: job.id, type: job.type, input: { sourceId: job.input.sourceId } },
  attemptsMade,
  opts: { attempts },
});

describe('planning helpers', () => {
  test('chunks never split a part and skip empty parts', () => {
    const parts = [1200, 0, 3000, 2500, 4900, 100].map((charCount, index) => ({ index, page: index + 1, charCount, blocks: charCount ? [{}] : [] }));
    const chunks = planChunks(parts, 5000);
    expect(chunks.map((c) => c.parts.map((p) => p.index))).toEqual([[0, 2], [3], [4, 5]]);
    expect(chunks.map((c) => [c.partStart, c.partEnd])).toEqual([[0, 2], [3, 3], [4, 5]]);
  });

  test('allowed references come from parts that contain text', () => {
    const parts = [
      { page: 1, headingPath: [], blocks: [{ kind: 'heading', text: 'Intro' }] },
      { page: 2, headingPath: ['Intro'], blocks: [] },
      { page: 3, headingPath: ['Intro', 'Method'], blocks: [{ kind: 'paragraph', text: 'x' }] },
    ];
    expect(allowedReferences(parts)).toEqual({ allowedPages: [1, 3], allowedSections: ['Intro', 'Method'] });
  });
});

describe('summarize_document', () => {
  test('short documents: extract -> parts saved per page -> direct summary with references', async () => {
    const { source, job, upload } = await createDocumentSource();
    processingClient.extractDocument.mockResolvedValue(
      extraction([pdfPart(1, 'Trees cool cities. '.repeat(20)), pdfPart(2, 'Canopy is 31% in rich districts.'), pdfPart(3, 'Fund maintenance.')])
    );
    processingClient.summarizeDocument.mockResolvedValue(SUMMARY);

    await processJob(bullJob(job));

    expect(processingClient.extractDocument).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'pdf', maxPages: 1000, downloadUrl: expect.stringMatching(/^https:/) })
    );
    expect(storageMock.__state.signed.every((s) => s.key === upload.storageKey && s.ttlSeconds <= 900)).toBe(true);
    const parts = await DocumentPart.find({ source: source._id }).sort({ index: 1 });
    expect(parts.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(parts[1].headingPath).toEqual(['Introduction']);

    const call = processingClient.summarizeDocument.mock.calls[0][0];
    expect(call.mode).toBe('direct');
    expect(call.parts.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(processingClient.summarizeDocumentChunk).not.toHaveBeenCalled();

    const updated = await Source.findById(source.id);
    expect(updated.status).toBe('completed');
    expect(updated.metadata.title).toBe('Urban Heat Report');
    expect(updated.document).toMatchObject({ format: 'pdf', pageCount: 3, partCount: 3, strategy: 'direct', author: 'Example Institute' });

    const summary = await Summary.findById(updated.summary);
    expect(summary.keyTakeaways).toEqual(['Trees cool cities.', 'Canopy is unequal.', 'Fund maintenance.']);
    expect(summary.references.keyTakeaways.map((x) => x.pages)).toEqual([[1], [2], [3]]);
    expect(summary.facts[0].toObject()).toEqual({ statement: 'Canopy is 31% in rich districts.', pages: [2], section: null });
    expect(summary.sectionBreakdown[0].pages).toEqual([1]);
    expect(summary.usage.toObject()).toEqual({ inputTokens: 800, outputTokens: 300 });
  });

  test('long documents: map (chunk notes) -> reduce (combine) with allowed pages; notes deleted afterwards', async () => {
    const { source, job } = await createDocumentSource();
    const text = 'Sentence about urban heat islands and canopy. '.repeat(60); // ~2800 chars per page
    processingClient.extractDocument.mockResolvedValue(extraction([1, 2, 3, 4, 5].map((p) => pdfPart(p, text))));
    processingClient.summarizeDocumentChunk.mockResolvedValue({ notes: NOTES, model: 'g', references_discarded: 0, usage: { input_tokens: 100, output_tokens: 50 } });
    processingClient.summarizeDocument.mockResolvedValue({ ...SUMMARY, mode: 'combine' });

    await processJob(bullJob(job));

    // 5 pages x ~2760 chars with a 5000-char chunk budget -> one page per chunk (parts are never split).
    const chunkCalls = processingClient.summarizeDocumentChunk.mock.calls.map(([c]) => [c.chunkIndex, c.chunkCount, c.parts.map((p) => p.page)]);
    expect(chunkCalls).toEqual([
      [0, 5, [1]],
      [1, 5, [2]],
      [2, 5, [3]],
      [3, 5, [4]],
      [4, 5, [5]],
    ]);

    const combine = processingClient.summarizeDocument.mock.calls[0][0];
    expect(combine.mode).toBe('combine');
    expect(combine.notes).toHaveLength(chunkCalls.length);
    expect(combine.allowedPages).toEqual([1, 2, 3, 4, 5]);
    expect(combine.allowedSections).toEqual(['Introduction']);

    const updated = await Source.findById(source.id);
    expect(updated.status).toBe('completed');
    expect(updated.document.strategy).toBe('combine');
    expect(await DocumentChunk.countDocuments()).toBe(0);
    const summary = await Summary.findById(updated.summary);
    expect(summary.usage.inputTokens).toBe(800 + 100 * chunkCalls.length);
  });

  test('a failed chunk is retried without re-extracting or redoing finished chunks', async () => {
    const { source, job } = await createDocumentSource();
    const text = 'Sentence about urban heat islands and canopy. '.repeat(60);
    processingClient.extractDocument.mockResolvedValue(extraction([1, 2, 3, 4].map((p) => pdfPart(p, text))));
    processingClient.summarizeDocumentChunk
      .mockResolvedValueOnce({ notes: NOTES, model: 'g', references_discarded: 0, usage: {} })
      .mockRejectedValueOnce(new ProcessingServiceError('busy', { code: 'AI_RATE_LIMITED', retryable: true }))
      .mockResolvedValue({ notes: NOTES, model: 'g', references_discarded: 0, usage: {} });
    processingClient.summarizeDocument.mockResolvedValue({ ...SUMMARY, mode: 'combine' });

    await expect(processJob(bullJob(job, { attemptsMade: 0 }))).rejects.toThrow('busy');
    const midway = await Source.findById(source.id);
    expect(midway.status).toBe('summarizing');
    expect(midway.progress.toObject()).toMatchObject({ stage: 'chunks', current: 1 });
    expect(await DocumentChunk.countDocuments()).toBe(1);

    await processJob(bullJob(job, { attemptsMade: 1 }));

    expect(processingClient.extractDocument).toHaveBeenCalledTimes(1);
    const indexes = processingClient.summarizeDocumentChunk.mock.calls.map(([c]) => c.chunkIndex);
    expect(indexes.filter((i) => i === 0)).toHaveLength(1); // chunk 0 never redone
    expect((await Source.findById(source.id)).status).toBe('completed');
  });

  test('scanned pages are OCR\'d in batches, capped by DOCUMENT_MAX_OCR_PAGES with an honest warning', async () => {
    const { source, job } = await createDocumentSource();
    const parts = [pdfPart(1, 'Typed first page with enough text to count.')];
    for (let page = 2; page <= 6; page += 1) parts.push(pdfPart(page, '', { needs_ocr: true }));
    processingClient.extractDocument.mockResolvedValue(extraction(parts));
    processingClient.ocrDocumentPages.mockImplementation(async ({ pages }) => ({
      pages: pages.map((page) => ({ page, blocks: [{ kind: 'paragraph', text: `Recognized text of page ${page}.`, level: null }] })),
      provider: 'gemini',
      model: 'g',
    }));
    processingClient.summarizeDocument.mockResolvedValue(SUMMARY);

    await processJob(bullJob(job));

    expect(processingClient.ocrDocumentPages.mock.calls.map(([c]) => c.pages)).toEqual([[2, 3], [4]]); // cap 3, batches of 2
    const updated = await Source.findById(source.id);
    expect(updated.document.ocrPages).toEqual([2, 3, 4]);
    expect(updated.document.ocrSkippedPages).toEqual([5, 6]);
    expect(updated.document.truncated).toBe(true);
    expect(updated.document.warnings.join(' ')).toMatch(/Only 3 of 5 scanned pages/);
    const page3 = await DocumentPart.findOne({ source: source._id, page: 3 });
    expect(page3).toMatchObject({ ocrDone: true, needsOcr: false });
    expect(page3.blocks[0].text).toBe('Recognized text of page 3.');
    const sent = processingClient.summarizeDocument.mock.calls[0][0];
    expect(sent.parts.map((p) => p.page)).toEqual([1, 2, 3, 4]); // skipped pages are not sent
    expect(sent.truncated).toBe(true);
  });

  test('a document with no text at all fails permanently', async () => {
    const { source, job } = await createDocumentSource();
    processingClient.extractDocument.mockResolvedValue(extraction([pdfPart(1, '', { needs_ocr: true })]));
    processingClient.ocrDocumentPages.mockResolvedValue({ pages: [{ page: 1, blocks: [] }], provider: 'gemini', model: 'g' });

    await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);
    const failed = await Source.findById(source.id);
    expect(failed.error.code).toBe('DOCUMENT_NO_TEXT');
    expect(processingClient.summarizeDocument).not.toHaveBeenCalled();
  });

  test.each([
    ['DOCUMENT_ENCRYPTED', 'This PDF is password-protected. Remove the password and upload it again.'],
    ['DOCUMENT_INVALID', 'The PDF is damaged or could not be read.'],
    ['DOCUMENT_MACROS', 'Macro-enabled Word documents are not supported. Save it as a regular .docx and upload it again.'],
  ])('%s fails immediately with the user-facing reason and schedules file cleanup', async (code, message) => {
    const { source, job, upload } = await createDocumentSource({ expiresAt: new Date(Date.now() + 30 * 86400000) });
    processingClient.extractDocument.mockRejectedValue(new ProcessingServiceError(message, { code, retryable: false }));

    await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);

    expect((await Source.findById(source.id)).error.toObject()).toEqual({ code, message });
    expect((await Upload.findById(upload.id)).expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000 + 1000);
  });

  test('a missing file fails clearly (before extraction)', async () => {
    const { source, job, upload } = await createDocumentSource();
    await Upload.updateOne({ _id: upload._id }, { $set: { status: 'deleted' } });

    await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await Source.findById(source.id)).error.code).toBe('DOCUMENT_UPLOAD_MISSING');
  });

  test('after extraction, summarizing no longer needs the original file', async () => {
    const { source, job, upload } = await createDocumentSource();
    processingClient.extractDocument.mockResolvedValue(extraction([pdfPart(1, 'Some text on the first page here.')]));
    processingClient.summarizeDocument.mockRejectedValueOnce(new ProcessingServiceError('busy', { code: 'AI_UNAVAILABLE', retryable: true }));
    await expect(processJob(bullJob(job))).rejects.toThrow('busy');

    await Upload.updateOne({ _id: upload._id }, { $set: { status: 'deleted' } }); // file cleaned up meanwhile
    processingClient.summarizeDocument.mockResolvedValue(SUMMARY);
    await processJob(bullJob(job, { attemptsMade: 1 }));

    expect((await Source.findById(source.id)).status).toBe('completed');
  });

  test('malformed extraction and summary payloads are rejected', async () => {
    const { job } = await createDocumentSource();
    processingClient.extractDocument.mockResolvedValue({ format: 'pdf', parts: 'nope' });
    await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);

    const second = await createDocumentSource();
    await Source.updateOne({ _id: second.source._id }, { $set: { normalizedUrl: 'upload:other' } });
    processingClient.extractDocument.mockResolvedValue(extraction([pdfPart(1, 'Text text text text.')]));
    processingClient.summarizeDocument.mockResolvedValue({ ...SUMMARY, summary: { ...SUMMARY.summary, key_takeaways: 'x' } });
    await expect(processJob(bullJob(second.job))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await Summary.countDocuments()).toBe(0);
  });
});
