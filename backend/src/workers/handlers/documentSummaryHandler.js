'use strict';

/**
 * summarize_document job:
 *
 *   extracting   Python downloads the stored file (signed URL), extracts parts
 *                (PDF pages / DOCX+TXT sections). Parts are saved one MongoDB
 *                document each (DocumentPart).
 *                Scanned PDF pages are OCR'd in small batches (progress "ocr"),
 *                capped at DOCUMENT_MAX_OCR_PAGES for cost control.
 *   summarizing  short documents: one direct request.
 *                long documents (map): chunks of about DOCUMENT_CHUNK_CHARS at part
 *                boundaries, each -> structured notes (DocumentChunk, resumable).
 *   combining    (reduce) notes -> final summary; the processing service merges
 *                notes hierarchically if they are still too large.
 *
 * Every page / section reference is validated against the processed text by
 * the processing service. Intermediate chunk notes are deleted once the
 * summary is saved.
 */

const { UnrecoverableError } = require('bullmq');
const config = require('../../config/env');
const Source = require('../../models/Source');
const Summary = require('../../models/Summary');
const Upload = require('../../models/Upload');
const DocumentPart = require('../../models/DocumentPart');
const DocumentChunk = require('../../models/DocumentChunk');
const storage = require('../../services/storageService');
const processingClient = require('../../services/processingClient');
const { summaryInputHash, reuseSummary } = require('../../services/ai/summaryCache');
const { ProcessingServiceError } = processingClient;
const { SOURCE_STATUSES } = require('../../queues/constants');
const { extractionSchema, ocrSchema, chunkResultSchema, summaryResultSchema } = require('../../validators/documentValidators');

function invalid(code, message) {
  return new ProcessingServiceError(message, { code, retryable: false });
}

async function signedUrl(upload) {
  const { url } = await storage.getSignedDownloadUrl(upload.storageKey, { ttlSeconds: 900 });
  return url;
}

function setStage(sourceId, status, progress = null) {
  return Source.updateOne({ _id: sourceId }, { $set: { status, error: null, progress } });
}

/** Groups consecutive parts into chunks of about `budget` characters, never splitting a part. */
function planChunks(parts, budget = config.documents.chunkChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const part of parts) {
    if (!part.blocks?.length) continue;
    if (current.length && size + part.charCount > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(part);
    size += part.charCount;
  }
  if (current.length) chunks.push(current);
  return chunks.map((chunkParts, index) => ({
    index,
    parts: chunkParts,
    partStart: chunkParts[0].index,
    partEnd: chunkParts[chunkParts.length - 1].index,
  }));
}

function allowedReferences(parts) {
  const pages = new Set();
  const sections = new Set();
  for (const part of parts) {
    if (!part.blocks?.length) continue;
    if (part.page) pages.add(part.page);
    for (const name of part.headingPath || []) sections.add(name);
    for (const block of part.blocks) if (block.kind === 'heading') sections.add(block.text);
  }
  return { allowedPages: [...pages].sort((a, b) => a - b), allowedSections: [...sections].slice(0, 20000) };
}

/** Embedded titles are often generator noise ("Microsoft Word - draft.docx", "Untitled"). */
function usefulTitle(title) {
  if (!title || title.length < 3) return null;
  if (/^(microsoft word|untitled|document\d*$|slide \d+)/i.test(title) || /\.(docx?|pdf|txt)$/i.test(title)) return null;
  return title.slice(0, 300);
}

const toBlocks = (blocks) => blocks.map((b) => ({ kind: b.kind, text: b.text, level: b.level ?? null }));

async function extract(source, upload) {
  await setStage(source._id, SOURCE_STATUSES.EXTRACTING, { current: 0, total: 1, stage: 'reading' });
  const parsed = extractionSchema.safeParse(
    await processingClient.extractDocument({
      downloadUrl: await signedUrl(upload),
      format: upload.container,
      maxPages: config.documents.maxPages,
    })
  );
  if (!parsed.success) throw invalid('DOCUMENT_BAD_EXTRACTION', 'The extracted document could not be used.');
  const result = parsed.data;

  // Idempotent: a retry after a partial save replaces the previous parts.
  await DocumentPart.deleteMany({ source: source._id });
  const docs = result.parts.map((part) => ({
    user: source.user,
    source: source._id,
    index: part.index,
    page: part.page,
    headingPath: part.heading_path,
    blocks: toBlocks(part.blocks),
    needsOcr: part.needs_ocr,
    ocrDone: false,
    charCount: part.char_count,
  }));
  for (let i = 0; i < docs.length; i += 500) await DocumentPart.insertMany(docs.slice(i, i + 500), { ordered: true });

  const ocrPages = result.ocr_pages;
  const ocrAllowed = ocrPages.slice(0, config.documents.maxOcrPages);
  const warnings = [...result.warnings];
  if (ocrPages.length > ocrAllowed.length) {
    warnings.push(
      `Only ${ocrAllowed.length} of ${ocrPages.length} scanned pages were read with text recognition (OCR limit).`
    );
  }
  await Source.updateOne(
    { _id: source._id },
    {
      $set: {
        'metadata.title': usefulTitle(result.metadata.title) || source.metadata?.title || 'Untitled document',
        'metadata.author': result.metadata.author ?? null,
        'metadata.wordCount': result.word_count,
        document: {
          format: result.format,
          pageCount: result.page_count,
          pagesProcessed: result.pages_processed,
          partCount: result.parts.length,
          wordCount: result.word_count,
          charCount: result.char_count,
          author: result.metadata.author ?? null,
          subject: result.metadata.subject ?? null,
          created: result.metadata.created ?? null,
          modified: result.metadata.modified ?? null,
          encoding: result.metadata.encoding ?? null,
          ocrPages: [],
          ocrSkippedPages: ocrPages.slice(ocrAllowed.length),
          truncated: result.truncated || ocrPages.length > ocrAllowed.length,
          warnings: warnings.slice(0, 20),
          strategy: null,
          extractedAt: new Date(),
        },
      },
    }
  );
  if (ocrPages.length > ocrAllowed.length) {
    await DocumentPart.updateMany({ source: source._id, page: { $in: ocrPages.slice(ocrAllowed.length) } }, { $set: { needsOcr: false } });
  }
}

async function runOcr(source, upload) {
  const pending = await DocumentPart.find({ source: source._id, needsOcr: true, ocrDone: false }).sort({ index: 1 }).select('page');
  const total = await DocumentPart.countDocuments({ source: source._id, $or: [{ needsOcr: true }, { ocrDone: true }] });
  if (!pending.length) return;

  let done = total - pending.length;
  const batchSize = config.documents.ocrBatchPages;
  for (let i = 0; i < pending.length; i += batchSize) {
    await setStage(source._id, SOURCE_STATUSES.EXTRACTING, { current: done, total, stage: 'ocr' });
    const pages = pending.slice(i, i + batchSize).map((p) => p.page);
    const parsed = ocrSchema.safeParse(await processingClient.ocrDocumentPages({ downloadUrl: await signedUrl(upload), pages }));
    if (!parsed.success) throw invalid('OCR_INVALID_RESPONSE', 'The text recognition result could not be used.');
    for (const page of parsed.data.pages) {
      if (!pages.includes(page.page)) continue;
      const blocks = toBlocks(page.blocks);
      await DocumentPart.updateOne(
        { source: source._id, page: page.page },
        { $set: { blocks, ocrDone: true, needsOcr: false, charCount: blocks.reduce((n, b) => n + b.text.length, 0) } }
      );
      await Source.updateOne({ _id: source._id }, { $addToSet: { 'document.ocrPages': page.page } });
      done += 1;
    }
  }
  const chars = await DocumentPart.aggregate([{ $match: { source: source._id } }, { $group: { _id: null, chars: { $sum: '$charCount' } } }]);
  await Source.updateOne({ _id: source._id }, { $set: { 'document.charCount': chars[0]?.chars ?? 0 } });
}

async function summarize(source) {
  const fresh = await Source.findById(source._id);
  const doc = fresh.document;
  const parts = await DocumentPart.find({ source: source._id }).sort({ index: 1 }).lean();
  const totalChars = parts.reduce((n, p) => n + (p.blocks?.length ? p.charCount : 0), 0);
  if (totalChars === 0) {
    throw new ProcessingServiceError(
      doc.ocrSkippedPages?.length
        ? 'No readable text was found within the text-recognition page limit.'
        : 'No readable text was found in this document.',
      { code: 'DOCUMENT_NO_TEXT', retryable: false }
    );
  }
  const title = fresh.metadata?.title;
  const inputHash = summaryInputHash('document', [
    title || null,
    doc.format,
    Boolean(doc.truncated),
    parts.map((p) => [p.index, p.page ?? null, p.headingPath || [], (p.blocks || []).map((b) => [b.kind, b.text])]),
  ]);
  const cached = await reuseSummary(fresh, inputHash);
  if (cached) return cached;
  const { allowedPages, allowedSections } = allowedReferences(parts);
  const usage = { inputTokens: 0, outputTokens: 0 };

  let result;
  if (totalChars <= config.documents.singlePassChars) {
    await setStage(source._id, SOURCE_STATUSES.SUMMARIZING, { current: 0, total: 1, stage: 'summary' });
    await Source.updateOne({ _id: source._id }, { $set: { 'document.strategy': 'direct' } });
    result = await processingClient.summarizeDocument({
      title,
      format: doc.format,
      pageCount: doc.pageCount,
      mode: 'direct',
      parts: parts.filter((p) => p.blocks?.length),
      truncated: doc.truncated,
    });
  } else {
    await Source.updateOne({ _id: source._id }, { $set: { 'document.strategy': 'combine' } });
    const chunks = planChunks(parts);
    const finished = new Map((await DocumentChunk.find({ source: source._id }).lean()).map((c) => [c.index, c]));
    for (const chunk of chunks) {
      const stored = finished.get(chunk.index);
      // Reuse stored notes only if the chunk boundaries still match (they always do unless re-extracted).
      if (stored && stored.partStart === chunk.partStart && stored.partEnd === chunk.partEnd) continue;
      await setStage(source._id, SOURCE_STATUSES.SUMMARIZING, { current: chunk.index, total: chunks.length, stage: 'chunks' });
      const parsed = chunkResultSchema.safeParse(
        await processingClient.summarizeDocumentChunk({
          title,
          format: doc.format,
          chunkIndex: chunk.index,
          chunkCount: chunks.length,
          parts: chunk.parts,
        })
      );
      if (!parsed.success) throw invalid('AI_INVALID_RESPONSE', 'A section summary could not be used.');
      await DocumentChunk.findOneAndUpdate(
        { source: source._id, index: chunk.index },
        {
          $set: {
            user: source.user,
            partStart: chunk.partStart,
            partEnd: chunk.partEnd,
            notes: parsed.data.notes,
            usage: { inputTokens: parsed.data.usage.input_tokens || 0, outputTokens: parsed.data.usage.output_tokens || 0 },
          },
        },
        { upsert: true }
      );
    }
    const notes = await DocumentChunk.find({ source: source._id, index: { $lt: chunks.length } }).sort({ index: 1 }).lean();
    for (const note of notes) {
      usage.inputTokens += note.usage?.inputTokens || 0;
      usage.outputTokens += note.usage?.outputTokens || 0;
    }
    await setStage(source._id, SOURCE_STATUSES.COMBINING, { current: chunks.length, total: chunks.length, stage: 'combine' });
    result = await processingClient.summarizeDocument({
      title,
      format: doc.format,
      pageCount: doc.pageCount,
      mode: 'combine',
      notes: notes.map((n) => n.notes),
      allowedPages,
      allowedSections,
      truncated: doc.truncated,
    });
  }

  const parsed = summaryResultSchema.safeParse(result);
  if (!parsed.success) throw invalid('AI_INVALID_RESPONSE', 'The summary result could not be used.');
  const { summary, model, prompt_version: promptVersion, input_characters: inputCharacters } = parsed.data;
  usage.inputTokens += parsed.data.usage.input_tokens || 0;
  usage.outputTokens += parsed.data.usage.output_tokens || 0;
  const ref = (item) => ({ pages: item.pages || [], section: item.section ?? null });

  const saved = await Summary.findOneAndUpdate(
    { source: source._id },
    {
      $set: {
        user: source.user,
        title: summary.title,
        overview: summary.overview,
        sections: summary.sections,
        keyTakeaways: summary.key_takeaways.map((t) => t.text),
        mainArguments: summary.main_arguments.map((a) => a.text),
        concepts: summary.concepts.map((c) => ({ term: c.term, explanation: c.explanation })),
        sectionBreakdown: summary.section_breakdown.map((s) => ({ title: s.title, summary: s.summary, ...ref(s) })),
        facts: summary.facts.map((f) => ({ statement: f.statement, ...ref(f) })),
        references: {
          keyTakeaways: summary.key_takeaways.map(ref),
          mainArguments: summary.main_arguments.map(ref),
          concepts: summary.concepts.map(ref),
        },
        model,
        promptVersion,
        inputHash,
        inputTruncated: Boolean(doc.truncated),
        inputCharacters,
        usage,
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  await Source.updateOne(
    { _id: source._id },
    { $set: { status: SOURCE_STATUSES.COMPLETED, summary: saved._id, completedAt: new Date(), error: null, failedAt: null, progress: null } }
  );
  // Intermediate map-step state is no longer needed.
  await DocumentChunk.deleteMany({ source: source._id });
  return saved;
}

async function handleSummarizeDocument({ input }) {
  const source = await Source.findById(input.sourceId);
  if (!source) throw new UnrecoverableError('The document no longer exists.');
  if (source.status === SOURCE_STATUSES.COMPLETED && source.summary) {
    return { sourceId: source.id, summaryId: source.summary.toString() };
  }

  const upload = source.upload ? await Upload.findOne({ _id: source.upload, user: source.user }) : null;
  const needsFile = !source.document?.extractedAt || (await DocumentPart.exists({ source: source._id, needsOcr: true, ocrDone: false }));
  if (needsFile && (!upload || upload.status !== 'stored')) {
    throw new ProcessingServiceError('The uploaded file is no longer available. Please upload it again.', {
      code: 'DOCUMENT_UPLOAD_MISSING',
      retryable: false,
    });
  }

  if (!source.document?.extractedAt) await extract(source, upload);
  await runOcr(source, upload);
  const summary = await summarize(source);
  return { sourceId: source.id, summaryId: summary.id };
}

/** Permanent failure: mark the source failed and schedule the file for deletion soon. */
handleSummarizeDocument.onFinalFailure = async ({ input, error }) => {
  await Source.updateOne(
    { _id: input.sourceId, status: { $ne: SOURCE_STATUSES.COMPLETED } },
    { $set: { status: SOURCE_STATUSES.FAILED, error, failedAt: new Date(), progress: null } }
  );
  const source = await Source.findById(input.sourceId).select('upload');
  if (source?.upload) {
    const soon = new Date(Date.now() + config.uploads.failedRetentionHours * 3600 * 1000);
    await Upload.updateOne({ _id: source.upload, status: 'stored', expiresAt: { $gt: soon } }, { $set: { expiresAt: soon } });
  }
};

module.exports = handleSummarizeDocument;
module.exports.planChunks = planChunks;
module.exports.allowedReferences = allowedReferences;
