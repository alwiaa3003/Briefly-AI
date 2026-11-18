'use strict';

const sourceService = require('../services/sourceService');
const uploadService = require('../services/uploadService');
const directUploadService = require('../services/directUploadService');
const { SOURCE_KINDS } = require('../queues/constants');
const { sendSuccess } = require('../utils/http');

function jobSummary(job) {
  return job ? { id: job.id, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts } : null;
}

/** 202 when a job was queued, 200 when an existing summary is reused. */
function respondWithSubmission(res, { source, job, outcome }) {
  const statusCode = outcome === 'existing' ? 200 : 202;
  return sendSuccess(res, statusCode, { source: source.toJSON(), job: jobSummary(job), duplicate: outcome === 'existing' });
}

/** POST /api/articles */
async function submitArticle(req, res) {
  return respondWithSubmission(res, await sourceService.submitArticle({ userId: req.auth.userId, url: req.body.url }));
}

/** POST /api/videos/youtube */
async function submitYouTube(req, res) {
  return respondWithSubmission(res, await sourceService.submitYouTube({ userId: req.auth.userId, url: req.body.url }));
}

/** POST /api/videos/uploads (multipart/form-data, field "file") */
async function uploadVideo(req, res) {
  const stored = await uploadService.receiveVideoUpload(req, { userId: req.auth.userId });
  return respondWithSubmission(res, await sourceService.submitUploadedVideo({ userId: req.auth.userId, stored }));
}

/** POST /api/documents/uploads (multipart/form-data, field "file": PDF, DOCX or TXT) */
async function uploadDocument(req, res) {
  const stored = await uploadService.receiveDocumentUpload(req, { userId: req.auth.userId });
  return respondWithSubmission(res, await sourceService.submitUploadedDocument({ userId: req.auth.userId, stored }));
}

/*
 * Direct uploads (browser -> object storage). Same responses as the streaming endpoints above:
 * start returns a presigned URL; complete returns { source, job, duplicate } once verified.
 */
function directUploadActions(kind) {
  return {
    async start(req, res) {
      res.set('Cache-Control', 'no-store');
      return sendSuccess(res, 201, await directUploadService.startUpload({ userId: req.auth.userId, kind, ...req.body }));
    },
    async complete(req, res) {
      const result = await directUploadService.completeUpload({ userId: req.auth.userId, kind, uploadId: req.params.uploadId });
      return respondWithSubmission(res, result);
    },
    async cancel(req, res) {
      await directUploadService.cancelUpload({ userId: req.auth.userId, kind, uploadId: req.params.uploadId });
      return res.status(204).end();
    },
  };
}

const directVideoUpload = directUploadActions(SOURCE_KINDS.VIDEO);
const directDocumentUpload = directUploadActions(SOURCE_KINDS.DOCUMENT);

/** GET /api/documents/uploads/config */
function getDocumentUploadConfig(_req, res) {
  return sendSuccess(res, 200, { uploads: sourceService.getDocumentUploadConfig() });
}

/** GET /api/sources/:id/original[?download=1] — short-lived signed URL for the original file. */
async function getOriginal(req, res) {
  const original = await sourceService.getOriginalFileUrl({
    userId: req.auth.userId,
    sourceId: req.params.id,
    download: req.query.download === '1' || req.query.download === 'true',
  });
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, 200, { original });
}

/** GET /api/sources/:id/document-text?page=&limit= — extracted text with page/section references. */
async function getDocumentText(req, res) {
  const result = await sourceService.getDocumentText({ userId: req.auth.userId, sourceId: req.params.id, ...req.query });
  return sendSuccess(res, 200, result);
}

/** GET /api/videos/uploads/config — lets the UI explain limits, or that uploads need setup. */
function getUploadConfig(_req, res) {
  return sendSuccess(res, 200, { uploads: sourceService.getUploadConfig() });
}

/** GET /api/sources */
async function listSources(req, res) {
  const result = await sourceService.listSources({ userId: req.auth.userId, ...req.query });
  return sendSuccess(res, 200, result);
}

/** GET /api/sources/stats */
async function getStats(req, res) {
  return sendSuccess(res, 200, { stats: await sourceService.getSourceStats({ userId: req.auth.userId }) });
}

/** GET /api/sources/:id */
async function getSource(req, res) {
  const source = await sourceService.getSourceDetail({ userId: req.auth.userId, sourceId: req.params.id });
  return sendSuccess(res, 200, { source });
}

/** GET /api/sources/:id/transcript */
async function getTranscript(req, res) {
  const transcript = await sourceService.getTranscript({ userId: req.auth.userId, sourceId: req.params.id });
  return sendSuccess(res, 200, { transcript });
}

/** GET /api/sources/:id/playback — short-lived signed URL for an uploaded video. */
async function getPlayback(req, res) {
  const { url, expiresAt } = await sourceService.getPlaybackUrl({ userId: req.auth.userId, sourceId: req.params.id });
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, 200, { playback: { url, expiresAt } });
}

/** POST /api/sources/:id/retry */
async function retrySource(req, res) {
  const { source, job } = await sourceService.retrySource({ userId: req.auth.userId, sourceId: req.params.id });
  return sendSuccess(res, 202, { source: source.toJSON(), job: jobSummary(job) });
}

module.exports = {
  directVideoUpload,
  directDocumentUpload,
  submitArticle,
  submitYouTube,
  uploadVideo,
  uploadDocument,
  getDocumentUploadConfig,
  getOriginal,
  getDocumentText,
  getUploadConfig,
  listSources,
  getStats,
  getSource,
  getTranscript,
  getPlayback,
  retrySource,
};
