'use strict';

const mongoose = require('mongoose');
const config = require('../config/env');
const Source = require('../models/Source');
const Summary = require('../models/Summary');
const Upload = require('../models/Upload');
const Transcript = require('../models/Transcript');
const DocumentPart = require('../models/DocumentPart');
const ProcessingJob = require('../models/ProcessingJob');
const jobService = require('./jobService');
const storage = require('./storageService');
const { isQueueAvailable } = require('../queues/processingQueue');
const { JOB_TYPE_BY_KIND, SOURCE_KINDS, SOURCE_STATUSES, SOURCE_IN_PROGRESS_STATUSES } = require('../queues/constants');
const { parseArticleUrl } = require('../utils/articleUrl');
const { parseYouTubeUrl } = require('../utils/youtubeUrl');
const { titleFromFilename } = require('../utils/videoFile');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const DUPLICATE_KEY_ERROR = 11000;
const DAY_MS = 24 * 60 * 60 * 1000;

function ensureQueueAvailable() {
  if (!isQueueAvailable()) {
    throw ApiError.serviceUnavailable(jobService.QUEUE_UNAVAILABLE_MESSAGE, 'QUEUE_UNAVAILABLE');
  }
}

/** Queues the summarize job matching the source's kind and links it. */
async function startSummaryJob(source) {
  let job;
  try {
    job = await jobService.enqueueProcessingJob({
      userId: source.user,
      type: JOB_TYPE_BY_KIND[source.kind],
      input: { sourceId: source.id },
      sourceId: source._id,
    });
  } catch (error) {
    await Source.updateOne(
      { _id: source._id },
      {
        $set: {
          status: SOURCE_STATUSES.FAILED,
          failedAt: new Date(),
          error: { code: 'QUEUE_UNAVAILABLE', message: 'The summary could not be queued. Please try again.' },
        },
      }
    );
    throw error;
  }
  await Source.updateOne({ _id: source._id }, { $set: { latestJob: job._id } });
  source.latestJob = job._id;
  return job;
}

/**
 * Shared duplicate-aware creation for URL-based kinds.
 *   existing + completed/in progress -> returned as is (outcome 'existing')
 *   existing + failed                -> re-queued (outcome 'requeued')
 */
async function createOrReuseSource({ userId, normalizedUrl, create }) {
  const existing = await Source.findOne({ user: userId, normalizedUrl });
  if (existing) {
    if (existing.status === SOURCE_STATUSES.FAILED) {
      const { source, job } = await retrySource({ userId, sourceId: existing.id });
      return { source, job, outcome: 'requeued' };
    }
    return { source: existing, job: null, outcome: 'existing' };
  }

  ensureQueueAvailable();

  let source;
  try {
    source = await Source.create({ user: userId, normalizedUrl, status: SOURCE_STATUSES.QUEUED, ...create });
  } catch (error) {
    // A concurrent submission of the same item won the race; reuse its record.
    if (error && error.code === DUPLICATE_KEY_ERROR) {
      return { source: await Source.findOne({ user: userId, normalizedUrl }), job: null, outcome: 'existing' };
    }
    throw error;
  }

  const job = await startSummaryJob(source);
  logger.info('Source submitted', { sourceId: source.id, kind: source.kind, jobId: job.id });
  return { source, job, outcome: 'created' };
}

/* ------------------------------ Submission ------------------------------ */

/** @returns {{ source, job, outcome: 'created' | 'requeued' | 'existing' }} */
function submitArticle({ userId, url }) {
  const { url: cleanUrl, normalizedUrl } = parseArticleUrl(url);
  return createOrReuseSource({
    userId,
    normalizedUrl,
    create: { kind: SOURCE_KINDS.ARTICLE, submittedUrl: cleanUrl },
  });
}

/** Duplicate key is the video id, so every URL form of the same video maps to one source. */
function submitYouTube({ userId, url }) {
  const { videoId, url: watchUrl, normalizedUrl } = parseYouTubeUrl(url);
  return createOrReuseSource({
    userId,
    normalizedUrl,
    create: {
      kind: SOURCE_KINDS.YOUTUBE,
      submittedUrl: watchUrl,
      canonicalUrl: watchUrl,
      metadata: { siteName: 'YouTube' },
      video: { platform: 'youtube', videoId },
    },
  });
}

/**
 * Registers a stored upload and queues it. Identical files (same SHA-256) from the
 * same user reuse the existing summary; the duplicate object is deleted right away.
 */
const UPLOAD_KINDS = Object.freeze({
  [SOURCE_KINDS.VIDEO]: {
    retentionDays: () => config.uploads.retentionDays,
    create: () => ({ video: { platform: 'upload' } }),
    label: 'Video',
  },
  [SOURCE_KINDS.DOCUMENT]: {
    retentionDays: () => config.documents.retentionDays,
    create: (stored) => ({ document: { format: stored.container } }),
    label: 'Document',
  },
});

function submitUploadedVideo({ userId, stored }) {
  return submitUploadedFile({ userId, stored, kind: SOURCE_KINDS.VIDEO });
}

function submitUploadedDocument({ userId, stored }) {
  return submitUploadedFile({ userId, stored, kind: SOURCE_KINDS.DOCUMENT });
}

async function submitUploadedFile({ userId, stored, kind }) {
  const settings = UPLOAD_KINDS[kind];
  const normalizedUrl = `upload:${stored.sha256}`;
  const discardStoredObject = () => storage.deleteObject(stored.storageKey).catch(() => {});

  const existing = await Source.findOne({ user: userId, normalizedUrl });
  if (existing && existing.status !== SOURCE_STATUSES.FAILED) {
    await discardStoredObject();
    return { source: existing, job: null, outcome: 'existing' };
  }

  let upload;
  try {
    upload = await Upload.create({
      user: userId,
      storageKey: stored.storageKey,
      originalName: stored.originalName,
      mimeType: stored.mimeType,
      container: stored.container,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      expiresAt: new Date(Date.now() + settings.retentionDays() * DAY_MS),
    });
  } catch (error) {
    // Without an Upload record nothing would ever delete the stored object: remove it now.
    await discardStoredObject();
    throw error;
  }

  if (existing) {
    // Previously failed upload of the same file: attach the fresh copy and retry.
    if (existing.upload) {
      await Upload.updateOne({ _id: existing.upload, status: 'stored' }, { $set: { expiresAt: new Date() } });
    }
    await Source.updateOne({ _id: existing._id }, { $set: { upload: upload._id } });
    await Upload.updateOne({ _id: upload._id }, { $set: { source: existing._id } });
    const { source, job } = await retrySource({ userId, sourceId: existing.id });
    return { source, job, outcome: 'requeued' };
  }

  try {
    ensureQueueAvailable();
  } catch (error) {
    await Upload.updateOne({ _id: upload._id }, { $set: { expiresAt: new Date() } });
    throw error;
  }

  let source;
  try {
    source = await Source.create({
      user: userId,
      kind,
      normalizedUrl,
      status: SOURCE_STATUSES.QUEUED,
      metadata: { title: titleFromFilename(stored.originalName) },
      ...settings.create(stored),
      upload: upload._id,
    });
  } catch (error) {
    await Upload.updateOne({ _id: upload._id }, { $set: { expiresAt: new Date() } });
    if (error && error.code === DUPLICATE_KEY_ERROR) {
      return { source: await Source.findOne({ user: userId, normalizedUrl }), job: null, outcome: 'existing' };
    }
    throw error;
  }
  await Upload.updateOne({ _id: upload._id }, { $set: { source: source._id } });

  const job = await startSummaryJob(source);
  logger.info(`${settings.label} upload submitted`, { sourceId: source.id, jobId: job.id, sizeBytes: stored.sizeBytes });
  return { source, job, outcome: 'created' };
}

/** Videos always need the file; documents only until their text has been fully extracted. */
async function retryNeedsFile(source) {
  if (source.kind === SOURCE_KINDS.VIDEO) return true;
  if (source.kind !== SOURCE_KINDS.DOCUMENT) return false;
  if (!source.document?.extractedAt) return true;
  return Boolean(await DocumentPart.exists({ source: source._id, needsOcr: true, ocrDone: false }));
}

/** Re-queues a failed source. Atomic: concurrent retries cannot start two jobs. */
async function retrySource({ userId, sourceId }) {
  ensureQueueAvailable();

  const current = await Source.findOne({ _id: sourceId, user: userId }).select('kind upload status document');
  if (!current) throw ApiError.notFound('Summary not found.', 'SOURCE_NOT_FOUND');
  if (await retryNeedsFile(current)) {
    const upload = current.upload ? await Upload.findOne({ _id: current.upload, user: userId }) : null;
    if (!upload || upload.status !== 'stored' || upload.expiresAt <= new Date()) {
      const noun = current.kind === SOURCE_KINDS.VIDEO ? 'video' : 'document';
      throw ApiError.conflict(`The uploaded file is no longer available. Please upload the ${noun} again.`, 'UPLOAD_EXPIRED');
    }
  }

  const source = await Source.findOneAndUpdate(
    { _id: sourceId, user: userId, status: SOURCE_STATUSES.FAILED },
    { $set: { status: SOURCE_STATUSES.QUEUED, error: null, failedAt: null, progress: null } },
    { new: true }
  );
  if (!source) throw ApiError.conflict('Only failed summaries can be retried.', 'NOT_RETRYABLE');

  const job = await startSummaryJob(source);
  return { source, job };
}

/* -------------------------------- Queries -------------------------------- */

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toListItem(source) {
  const json = source.toJSON();
  const summary =
    source.summary && typeof source.summary === 'object' && source.summary.overview !== undefined ? source.summary : null;
  return {
    id: json.id,
    kind: json.kind,
    status: json.status,
    url: json.canonicalUrl || json.finalUrl || json.submittedUrl || null,
    title: (summary && summary.title) || json.metadata?.title || null,
    siteName: json.metadata?.siteName || null,
    author: json.metadata?.author || null,
    publishedAt: json.metadata?.publishedAt || null,
    wordCount: json.metadata?.wordCount ?? null,
    thumbnailUrl: json.video?.thumbnailUrl || null,
    durationSeconds: json.video?.durationSeconds ?? null,
    format: json.document?.format || null,
    pageCount: json.document?.pageCount ?? null,
    overview: summary ? summary.overview : null,
    error: json.error || null,
    progress: json.progress || null,
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
    completedAt: json.completedAt,
  };
}

async function listSources({ userId, search, kind, status, page = 1, limit = 20 }) {
  const filter = { user: userId };
  if (kind) filter.kind = kind;
  if (status === 'processing') filter.status = { $in: SOURCE_IN_PROGRESS_STATUSES };
  else if (status) filter.status = status;
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [
      { 'metadata.title': pattern },
      { 'metadata.siteName': pattern },
      { 'metadata.author': pattern },
      { submittedUrl: pattern },
      { 'video.channelTitle': pattern },
    ];
  }

  const [items, total] = await Promise.all([
    Source.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: 'summary', select: 'title overview' }),
    Source.countDocuments(filter),
  ]);

  return {
    items: items.map(toListItem),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getSourceStats({ userId }) {
  const rows = await Source.aggregate([
    { $match: { user: new mongoose.Types.ObjectId(String(userId)) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  const processing = SOURCE_IN_PROGRESS_STATUSES.reduce((sum, status) => sum + (counts[status] || 0), 0);
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    completed: counts[SOURCE_STATUSES.COMPLETED] || 0,
    processing,
    failed: counts[SOURCE_STATUSES.FAILED] || 0,
  };
}

function uploadInfo(upload) {
  if (!upload) return null;
  const available = upload.status === 'stored' && upload.expiresAt > new Date();
  return {
    originalName: upload.originalName,
    container: upload.container,
    sizeBytes: upload.sizeBytes,
    durationSeconds: upload.durationSeconds,
    available,
    expiresAt: available ? upload.expiresAt : null,
  };
}

async function findOwnedSource(userId, sourceId) {
  const source = await Source.findOne({ _id: sourceId, user: userId });
  if (!source) throw ApiError.notFound('Summary not found.', 'SOURCE_NOT_FOUND');
  return source;
}

async function getSourceDetail({ userId, sourceId }) {
  const source = await findOwnedSource(userId, sourceId);

  const [summary, job, upload, transcript] = await Promise.all([
    source.summary ? Summary.findOne({ _id: source.summary, user: userId }) : null,
    source.latestJob ? ProcessingJob.findOne({ _id: source.latestJob, user: userId }) : null,
    source.upload ? Upload.findOne({ _id: source.upload, user: userId }) : null,
    source.transcript
      ? Transcript.findOne({ _id: source.transcript, user: userId }).select('wordCount completedAt language provider hasSpeakerLabels')
      : null,
  ]);

  const json = source.toJSON();
  return {
    ...json,
    upload: uploadInfo(upload),
    transcript: transcript?.completedAt
      ? {
          available: true,
          wordCount: transcript.wordCount,
          language: transcript.language,
          provider: transcript.provider,
          hasSpeakerLabels: transcript.hasSpeakerLabels,
        }
      : { available: false },
    url: json.canonicalUrl || json.finalUrl || json.submittedUrl || null,
    summary: summary ? summary.toJSON() : null,
    job: job
      ? {
          id: job.id,
          status: job.status,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          updatedAt: job.updatedAt,
          // While waiting for AI capacity: why, and roughly when it continues.
          waiting: job.status === 'queued' && job.nextAttemptAt ? { reason: job.error, nextAttemptAt: job.nextAttemptAt } : null,
        }
      : null,
  };
}

/** Full timed transcript of one of the user's video sources. */
async function getTranscript({ userId, sourceId }) {
  const source = await findOwnedSource(userId, sourceId);
  const transcript = source.transcript
    ? await Transcript.findOne({ _id: source.transcript, user: userId, completedAt: { $ne: null } })
    : null;
  if (!transcript) throw ApiError.notFound('No transcript is available for this item yet.', 'TRANSCRIPT_NOT_FOUND');
  return transcript.toJSON();
}

/** Short-lived, owner-only URL for playing an uploaded video in the browser. */
async function getPlaybackUrl({ userId, sourceId }) {
  const source = await findOwnedSource(userId, sourceId);
  if (source.kind !== SOURCE_KINDS.VIDEO || !source.upload) {
    throw ApiError.notFound('Playback is only available for uploaded videos.', 'PLAYBACK_NOT_AVAILABLE');
  }
  const upload = await Upload.findOne({ _id: source.upload, user: userId });
  if (!upload || upload.status !== 'stored' || upload.expiresAt <= new Date()) {
    throw new ApiError(
      410,
      'UPLOAD_EXPIRED',
      `The original video file was removed after ${config.uploads.retentionDays} days. The transcript and summary are still available.`
    );
  }
  const ttlSeconds = Math.min(config.storage.signedUrlTtlSeconds, 3600);
  return storage.getSignedDownloadUrl(upload.storageKey, { ttlSeconds, contentType: upload.mimeType, inline: true });
}

/**
 * Short-lived, owner-only URL for the original uploaded file: inline (PDF viewer)
 * or an attachment download with the original filename.
 */
async function getOriginalFileUrl({ userId, sourceId, download = false }) {
  const source = await findOwnedSource(userId, sourceId);
  if (![SOURCE_KINDS.VIDEO, SOURCE_KINDS.DOCUMENT].includes(source.kind) || !source.upload) {
    throw ApiError.notFound('There is no original file for this item.', 'ORIGINAL_NOT_AVAILABLE');
  }
  const upload = await Upload.findOne({ _id: source.upload, user: userId });
  if (!upload || upload.status !== 'stored' || upload.expiresAt <= new Date()) {
    const days = source.kind === SOURCE_KINDS.DOCUMENT ? config.documents.retentionDays : config.uploads.retentionDays;
    throw new ApiError(
      410,
      'UPLOAD_EXPIRED',
      `The original file was removed after ${days} days. The extracted text and summary are still available.`
    );
  }
  // Only PDFs (and videos) are shown inline; DOCX/TXT are always downloaded, never rendered by the browser.
  const inline = !download && (upload.container === 'pdf' || source.kind === SOURCE_KINDS.VIDEO);
  const ttlSeconds = Math.min(config.storage.signedUrlTtlSeconds, 3600);
  const signed = await storage.getSignedDownloadUrl(upload.storageKey, {
    ttlSeconds,
    contentType: upload.mimeType,
    inline,
    filename: upload.originalName,
  });
  return { ...signed, inline, filename: upload.originalName, format: upload.container };
}

/** Extracted document text (with page / section references), paginated by parts. */
async function getDocumentText({ userId, sourceId, page = 1, limit = 20 }) {
  const source = await findOwnedSource(userId, sourceId);
  if (source.kind !== SOURCE_KINDS.DOCUMENT || !source.document?.extractedAt) {
    throw ApiError.notFound('No extracted text is available for this item yet.', 'DOCUMENT_TEXT_NOT_FOUND');
  }
  const filter = { source: source._id, user: userId };
  const [parts, total] = await Promise.all([
    DocumentPart.find(filter).sort({ index: 1 }).skip((page - 1) * limit).limit(limit),
    DocumentPart.countDocuments(filter),
  ]);
  return {
    parts: parts.map((p) => ({ ...p.toJSON(), ocr: p.ocrDone })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

function getDocumentUploadConfig() {
  return {
    enabled: storage.isStorageConfigured(),
    maxBytes: config.documents.maxBytes,
    maxPages: config.documents.maxPages,
    retentionDays: config.documents.retentionDays,
    acceptedExtensions: ['.pdf', '.docx', '.txt'],
    acceptedMimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ],
  };
}

function getUploadConfig() {
  return {
    enabled: storage.isStorageConfigured(),
    maxBytes: config.uploads.maxBytes,
    maxDurationMinutes: config.uploads.maxDurationMinutes,
    retentionDays: config.uploads.retentionDays,
    acceptedExtensions: ['.mp4', '.m4v', '.mov', '.webm', '.mkv'],
    acceptedMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'],
  };
}

module.exports = {
  submitArticle,
  submitYouTube,
  submitUploadedVideo,
  submitUploadedDocument,
  getOriginalFileUrl,
  getDocumentText,
  getDocumentUploadConfig,
  retrySource,
  listSources,
  getSourceStats,
  getSourceDetail,
  getTranscript,
  getPlaybackUrl,
  getUploadConfig,
};
