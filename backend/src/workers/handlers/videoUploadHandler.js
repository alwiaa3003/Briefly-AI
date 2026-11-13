'use strict';

const { UnrecoverableError } = require('bullmq');
const config = require('../../config/env');
const Source = require('../../models/Source');
const Upload = require('../../models/Upload');
const storage = require('../../services/storageService');
const processingClient = require('../../services/processingClient');
const { ProcessingServiceError } = processingClient;
const { SOURCE_STATUSES } = require('../../queues/constants');
const { probeResultSchema } = require('../../validators/videoValidators');
const { transcribeInWindows, summarizeTranscript, markSourceFailed } = require('./videoPipeline');

/** A fresh short-lived URL per request, so long jobs never hit an expired link. */
async function signedUrl(upload) {
  const { url } = await storage.getSignedDownloadUrl(upload.storageKey, { ttlSeconds: 900 });
  return url;
}

/**
 * summarize_video_upload job:
 *   preparing    probe the stored file (duration limit, audio track present)
 *   transcribing ffmpeg audio window -> Gemini, window by window
 *   summarizing  summary + chapters + key moments grounded in the transcript
 *
 * The processing service only ever receives presigned GET URLs; it holds no storage credentials.
 */
async function handleSummarizeVideoUpload({ input }) {
  const source = await Source.findById(input.sourceId);
  if (!source) throw new UnrecoverableError('The video no longer exists.');
  if (source.status === SOURCE_STATUSES.COMPLETED && source.summary) {
    return { sourceId: source.id, summaryId: source.summary.toString() };
  }

  const upload = source.upload ? await Upload.findOne({ _id: source.upload, user: source.user }) : null;
  if (!upload || upload.status !== 'stored') {
    throw new ProcessingServiceError('The uploaded file is no longer available. Please upload it again.', {
      code: 'VIDEO_UPLOAD_MISSING',
      retryable: false,
    });
  }

  if (!upload.durationSeconds) {
    await Source.updateOne({ _id: source._id }, { $set: { status: SOURCE_STATUSES.PREPARING, error: null } });
    const parsed = probeResultSchema.safeParse(
      await processingClient.probeVideo({
        downloadUrl: await signedUrl(upload),
        container: upload.container,
        maxDurationSeconds: config.uploads.maxDurationMinutes * 60,
      })
    );
    if (!parsed.success) {
      throw new ProcessingServiceError('The video could not be analysed.', { code: 'MEDIA_INVALID', retryable: false });
    }
    upload.durationSeconds = parsed.data.duration_seconds;
    await upload.save();
    await Source.updateOne({ _id: source._id }, { $set: { 'video.durationSeconds': upload.durationSeconds } });
  }

  const transcript = await transcribeInWindows({
    source,
    origin: 'uploaded_video',
    durationSeconds: upload.durationSeconds,
    transcribeWindow: async (window) =>
      processingClient.transcribeUploadedVideo({
        downloadUrl: await signedUrl(upload),
        container: upload.container,
        startSeconds: window.start,
        endSeconds: window.end,
      }),
  });

  const summary = await summarizeTranscript({
    source,
    transcript,
    sourceKind: 'video',
    title: source.metadata?.title,
    channel: null,
    durationSeconds: upload.durationSeconds,
  });
  return { sourceId: source.id, summaryId: summary.id, transcriptId: transcript.id };
}

/** Permanent failure: mark the source failed and schedule the file for deletion soon. */
handleSummarizeVideoUpload.onFinalFailure = async ({ input, error }) => {
  await markSourceFailed(input.sourceId, error);
  const source = await Source.findById(input.sourceId).select('upload');
  if (source?.upload) {
    const soon = new Date(Date.now() + config.uploads.failedRetentionHours * 3600 * 1000);
    await Upload.updateOne({ _id: source.upload, status: 'stored', expiresAt: { $gt: soon } }, { $set: { expiresAt: soon } });
  }
};

module.exports = handleSummarizeVideoUpload;
