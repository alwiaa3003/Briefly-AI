'use strict';

const { UnrecoverableError } = require('bullmq');
const config = require('../../config/env');
const Source = require('../../models/Source');
const processingClient = require('../../services/processingClient');
const { ProcessingServiceError } = processingClient;
const { SOURCE_STATUSES } = require('../../queues/constants');
const { youtubeMetadataSchema } = require('../../validators/videoValidators');
const { transcribeInWindows, summarizeTranscript, markSourceFailed } = require('./videoPipeline');

/**
 * summarize_youtube job:
 *   preparing    official metadata (Data API or oEmbed) + availability checks
 *   transcribing Gemini's YouTube video input, window by window
 *   summarizing  summary + chapters + key moments grounded in the transcript
 */
async function handleSummarizeYouTube({ input }) {
  const source = await Source.findById(input.sourceId);
  if (!source) throw new UnrecoverableError('The video no longer exists.');
  if (source.status === SOURCE_STATUSES.COMPLETED && source.summary) {
    return { sourceId: source.id, summaryId: source.summary.toString() };
  }
  const videoId = source.video?.videoId;
  if (!videoId) throw new UnrecoverableError('The video reference is missing.');

  if (!source.video.metadataFetchedAt) {
    await Source.updateOne({ _id: source._id }, { $set: { status: SOURCE_STATUSES.PREPARING, error: null } });
    const parsed = youtubeMetadataSchema.safeParse(
      await processingClient.getYouTubeMetadata({
        videoId,
        maxDurationSeconds: config.video.youtubeMaxDurationMinutes * 60,
      })
    );
    if (!parsed.success) {
      throw new ProcessingServiceError('Video details could not be read.', { code: 'YOUTUBE_METADATA_FAILED', retryable: false });
    }
    const meta = parsed.data;
    source.video = {
      ...source.video.toObject(),
      channelTitle: meta.channel_title,
      channelUrl: meta.channel_url,
      thumbnailUrl: meta.thumbnail_url,
      durationSeconds: meta.duration_seconds,
      publishedAt: meta.published_at,
      captions: {
        available: meta.captions.available,
        manualLanguages: meta.captions.manual_languages,
        autoLanguages: meta.captions.auto_languages,
      },
      metadataSource: meta.metadata_source,
      metadataFetchedAt: new Date(),
    };
    source.metadata = {
      ...source.metadata,
      title: meta.title ? meta.title.slice(0, 300) : null,
      author: meta.channel_title,
      publishedAt: meta.published_at,
      siteName: 'YouTube',
    };
    source.canonicalUrl = meta.watch_url;
    await source.save();
  }

  const durationSeconds = source.video.durationSeconds;
  const transcript = await transcribeInWindows({
    source,
    origin: 'youtube_video',
    durationSeconds,
    transcribeWindow: (window) =>
      processingClient.transcribeYouTube({ videoId, startSeconds: window.start, endSeconds: window.end }),
  });

  const summary = await summarizeTranscript({
    source,
    transcript,
    sourceKind: 'youtube',
    title: source.metadata?.title,
    channel: source.video.channelTitle,
    durationSeconds: durationSeconds || transcript.durationSeconds,
  });
  return { sourceId: source.id, summaryId: summary.id, transcriptId: transcript.id };
}

handleSummarizeYouTube.onFinalFailure = ({ input, error }) => markSourceFailed(input.sourceId, error);

module.exports = handleSummarizeYouTube;
