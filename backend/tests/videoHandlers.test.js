'use strict';

/**
 * summarize_youtube / summarize_video_upload through the real processor, with the
 * processing service and storage mocked (no network, no Gemini, no R2).
 */

jest.mock('../src/services/storageService', () => require('./helpers/storageMock'));
jest.mock('../src/services/processingClient', () => {
  const actual = jest.requireActual('../src/services/processingClient');
  return {
    ...actual,
    getYouTubeMetadata: jest.fn(),
    transcribeYouTube: jest.fn(),
    probeVideo: jest.fn(),
    transcribeUploadedVideo: jest.fn(),
    summarizeVideo: jest.fn(),
  };
});

const mongoose = require('mongoose');
const { UnrecoverableError } = require('bullmq');
const processingClient = require('../src/services/processingClient');
const { ProcessingServiceError } = processingClient;
const storageMock = require('./helpers/storageMock');
const Source = require('../src/models/Source');
const Summary = require('../src/models/Summary');
const Transcript = require('../src/models/Transcript');
const Upload = require('../src/models/Upload');
const ProcessingJob = require('../src/models/ProcessingJob');
const { processJob } = require('../src/workers/processor');
const { planWindows } = require('../src/workers/handlers/videoPipeline');
const { startTestDatabase, clearTestDatabase, stopTestDatabase } = require('./helpers/db');

const ID = 'dQw4w9WgXcQ';

const METADATA = {
  video_id: ID,
  watch_url: `https://www.youtube.com/watch?v=${ID}`,
  title: 'How Urban Trees Cool Cities',
  channel_title: 'Science Channel',
  channel_url: 'https://www.youtube.com/channel/UC1',
  thumbnail_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
  duration_seconds: 1500, // 25 min -> windows [0,600) [600,1200) [1200,1500)
  published_at: '2025-03-01T10:00:00Z',
  privacy_status: 'public',
  metadata_source: 'youtube_data_api',
  captions: { available: true, manual_languages: ['en'], auto_languages: ['en'] },
};

function windowResult(start, end, texts = ['Speech at the start.', 'More speech.']) {
  return {
    segments: texts.map((text, i) => ({ start: start + i * 10, end: start + i * 10 + 9, text, speaker: i === 0 ? 'Speaker 1' : null })),
    language: 'en',
    provider: 'gemini',
    model: 'gemini-test',
    clip_start: start,
    clip_end: end,
  };
}

const SUMMARY = {
  summary: {
    title: 'How Urban Trees Cool Cities',
    overview: 'The talk explains how trees cool streets and why canopy is unevenly shared between districts.',
    sections: [{ heading: 'Cooling', content: 'Shade and evapotranspiration.' }],
    key_takeaways: ['Trees cool streets.', 'Canopy is unequal.', 'Protect mature trees.'],
    concepts: [{ term: 'Canopy', explanation: 'Tree cover.' }],
    main_arguments: ['Fund maintenance.'],
    chapters: [
      { title: 'Intro', start_seconds: 0, end_seconds: 600, summary: 'Intro.' },
      { title: 'Inequality', start_seconds: 600, end_seconds: 1500, summary: 'Canopy differs.' },
    ],
    key_moments: [{ seconds: 610, description: 'Key claim' }],
  },
  model: 'gemini-test',
  prompt_version: 'video-summary-v1',
  input_truncated: false,
  input_characters: 500,
  usage: { input_tokens: 900, output_tokens: 300 },
};

beforeAll(startTestDatabase);
beforeEach(() => storageMock.__reset());
afterEach(async () => {
  jest.resetAllMocks();
  await clearTestDatabase();
});
afterAll(stopTestDatabase);

function bullJob(job, { attemptsMade = 0, attempts = 3 } = {}) {
  return { data: { processingJobId: job.id, type: job.type, input: { sourceId: job.input.sourceId } }, attemptsMade, opts: { attempts } };
}

async function createYouTubeSource() {
  const user = new mongoose.Types.ObjectId();
  const source = await Source.create({
    user,
    kind: 'youtube',
    submittedUrl: METADATA.watch_url,
    normalizedUrl: `youtube:${ID}`,
    video: { platform: 'youtube', videoId: ID },
  });
  const job = await ProcessingJob.create({ user, type: 'summarize_youtube', source: source._id, input: { sourceId: source.id }, maxAttempts: 3 });
  return { source, job, user };
}

async function createUploadSource({ expiresAt = new Date(Date.now() + 86400000) } = {}) {
  const user = new mongoose.Types.ObjectId();
  const upload = await Upload.create({
    user,
    storageKey: `videos/${user}/abc`,
    originalName: 'Lecture.mov',
    mimeType: 'video/quicktime',
    container: 'mov',
    sizeBytes: 1000,
    sha256: 'a'.repeat(64),
    expiresAt,
  });
  const source = await Source.create({
    user,
    kind: 'video',
    normalizedUrl: `upload:${'a'.repeat(64)}`,
    metadata: { title: 'Lecture' },
    video: { platform: 'upload' },
    upload: upload._id,
  });
  const job = await ProcessingJob.create({ user, type: 'summarize_video_upload', source: source._id, input: { sourceId: source.id }, maxAttempts: 3 });
  return { source, job, upload, user };
}

describe('planWindows', () => {
  test.each([
    [1500, [[0, 600], [600, 1200], [1200, 1500]]],
    [600, [[0, 600]]],
    [610, [[0, 610]]], // tiny trailing window folded in
    [45, [[0, 45]]],
    [null, [[0, null]]], // unknown duration
  ])('%p seconds', (duration, expected) => {
    expect(planWindows(duration, 600).map((w) => [w.start, w.end])).toEqual(expected);
  });
});

describe('summarize_youtube', () => {
  test('metadata -> windowed transcription -> grounded summary', async () => {
    const { source, job } = await createYouTubeSource();
    processingClient.getYouTubeMetadata.mockResolvedValue(METADATA);
    processingClient.transcribeYouTube.mockImplementation(async ({ startSeconds, endSeconds }) => windowResult(startSeconds, endSeconds));
    processingClient.summarizeVideo.mockResolvedValue(SUMMARY);

    await processJob(bullJob(job));

    expect(processingClient.getYouTubeMetadata).toHaveBeenCalledWith({ videoId: ID, maxDurationSeconds: 180 * 60 });
    expect(processingClient.transcribeYouTube.mock.calls.map(([w]) => [w.startSeconds, w.endSeconds])).toEqual([
      [0, 600],
      [600, 1200],
      [1200, 1500],
    ]);

    const updated = await Source.findById(source.id);
    expect(updated.status).toBe('completed');
    expect(updated.progress).toBeNull();
    expect(updated.metadata).toMatchObject({ title: 'How Urban Trees Cool Cities', author: 'Science Channel', siteName: 'YouTube' });
    expect(updated.video).toMatchObject({ durationSeconds: 1500, thumbnailUrl: METADATA.thumbnail_url, metadataSource: 'youtube_data_api' });
    expect(updated.video.captions.toObject()).toEqual({ available: true, manualLanguages: ['en'], autoLanguages: ['en'] });

    const transcript = await Transcript.findById(updated.transcript);
    expect(transcript.segments.map((s) => s.start)).toEqual([0, 10, 600, 610, 1200, 1210]);
    expect(transcript).toMatchObject({ origin: 'youtube_video', provider: 'gemini', language: 'en', hasSpeakerLabels: true });
    expect(transcript.wordCount).toBeGreaterThan(0);
    expect(transcript.completedAt).toBeInstanceOf(Date);

    const segmentsSent = processingClient.summarizeVideo.mock.calls[0][0].segments;
    expect(segmentsSent).toHaveLength(6);
    const summary = await Summary.findById(updated.summary);
    expect(summary.chapters.map((c) => c.startSeconds)).toEqual([0, 600]);
    expect(summary.keyMoments[0].toObject()).toEqual({ seconds: 610, description: 'Key claim' });
  });

  test('a failed window is retried without redoing finished windows or duplicating segments', async () => {
    const { source, job } = await createYouTubeSource();
    processingClient.getYouTubeMetadata.mockResolvedValue(METADATA);
    processingClient.transcribeYouTube
      .mockImplementationOnce(async () => windowResult(0, 600))
      .mockRejectedValueOnce(new ProcessingServiceError('busy', { code: 'AI_RATE_LIMITED', retryable: true }))
      .mockImplementation(async ({ startSeconds, endSeconds }) => windowResult(startSeconds, endSeconds));
    processingClient.summarizeVideo.mockResolvedValue(SUMMARY);

    await expect(processJob(bullJob(job, { attemptsMade: 0 }))).rejects.toThrow('busy');
    const midway = await Source.findById(source.id);
    expect(midway.status).toBe('transcribing');
    expect(midway.progress.toObject()).toEqual({ current: 1, total: 3 });

    await processJob(bullJob(job, { attemptsMade: 1 }));

    expect(processingClient.getYouTubeMetadata).toHaveBeenCalledTimes(1); // metadata not refetched
    const starts = processingClient.transcribeYouTube.mock.calls.map(([w]) => w.startSeconds);
    expect(starts).toEqual([0, 600, 600, 1200]); // window 0 never repeated
    const transcript = await Transcript.findOne({ source: source._id });
    expect(transcript.segments).toHaveLength(6);
  });

  test('unknown duration (no Data API key) uses one open-ended window', async () => {
    const { job } = await createYouTubeSource();
    processingClient.getYouTubeMetadata.mockResolvedValue({ ...METADATA, duration_seconds: null, metadata_source: 'oembed' });
    processingClient.transcribeYouTube.mockResolvedValue(windowResult(0, null));
    processingClient.summarizeVideo.mockResolvedValue(SUMMARY);

    await processJob(bullJob(job));
    expect(processingClient.transcribeYouTube).toHaveBeenCalledWith({ videoId: ID, startSeconds: 0, endSeconds: null });
  });

  test.each([
    ['VIDEO_PRIVATE', 'This video is private.'],
    ['VIDEO_AGE_RESTRICTED', "Age-restricted videos can't be processed."],
    ['VIDEO_TOO_LONG', 'This video is longer than the 180-minute limit.'],
    ['VIDEO_NOT_FOUND', "This video doesn't exist, was removed, or is private."],
  ])('%s fails immediately with the user-facing reason', async (code, message) => {
    const { source, job } = await createYouTubeSource();
    processingClient.getYouTubeMetadata.mockRejectedValue(new ProcessingServiceError(message, { code, retryable: false }));

    await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);

    const failed = await Source.findById(source.id);
    expect(failed.status).toBe('failed');
    expect(failed.error.toObject()).toEqual({ code, message });
    expect(processingClient.transcribeYouTube).not.toHaveBeenCalled();
  });

  test('a video without speech fails honestly instead of producing a summary', async () => {
    const { source, job } = await createYouTubeSource();
    processingClient.getYouTubeMetadata.mockResolvedValue({ ...METADATA, duration_seconds: 300 });
    processingClient.transcribeYouTube.mockResolvedValue({ ...windowResult(0, 300), segments: [] });

    await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);

    const failed = await Source.findById(source.id);
    expect(failed.error.code).toBe('TRANSCRIPTION_NO_SPEECH');
    expect(processingClient.summarizeVideo).not.toHaveBeenCalled();
    expect(await Summary.countDocuments()).toBe(0);
  });

  test('malformed transcription and summary payloads are rejected', async () => {
    const { job } = await createYouTubeSource();
    processingClient.getYouTubeMetadata.mockResolvedValue({ ...METADATA, duration_seconds: 300 });
    processingClient.transcribeYouTube.mockResolvedValue({ segments: [{ start: -5, end: 1, text: '' }] });

    await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await Summary.countDocuments()).toBe(0);
  });

  test('segments outside the requested window are discarded', async () => {
    const { source, job } = await createYouTubeSource();
    processingClient.getYouTubeMetadata.mockResolvedValue({ ...METADATA, duration_seconds: 300 });
    processingClient.transcribeYouTube.mockResolvedValue({
      ...windowResult(0, 300),
      segments: [
        { start: 5, end: 9, text: 'Real.', speaker: null },
        { start: 900, end: 905, text: 'Impossible time.', speaker: null },
      ],
    });
    processingClient.summarizeVideo.mockResolvedValue(SUMMARY);

    await processJob(bullJob(job));
    const transcript = await Transcript.findOne({ source: source._id });
    expect(transcript.segments.map((s) => s.text)).toEqual(['Real.']);
  });
});

describe('summarize_video_upload', () => {
  test('probe -> windowed transcription with fresh signed URLs -> summary', async () => {
    const { source, job, upload } = await createUploadSource();
    processingClient.probeVideo.mockResolvedValue({ duration_seconds: 900.5, has_audio: true, has_video: true });
    processingClient.transcribeUploadedVideo.mockImplementation(async ({ startSeconds, endSeconds }) => windowResult(startSeconds, endSeconds));
    processingClient.summarizeVideo.mockResolvedValue(SUMMARY);

    await processJob(bullJob(job));

    expect(processingClient.probeVideo).toHaveBeenCalledWith(
      expect.objectContaining({ container: 'mov', maxDurationSeconds: 180 * 60, downloadUrl: expect.stringMatching(/^https:\/\//) })
    );
    const calls = processingClient.transcribeUploadedVideo.mock.calls.map(([c]) => c);
    expect(calls.map((c) => [c.startSeconds, c.endSeconds])).toEqual([[0, 600], [600, 900.5]]);
    // A new short-lived URL for every request; all for this upload's key only.
    expect(new Set(calls.map((c) => c.downloadUrl)).size).toBe(2);
    expect(storageMock.__state.signed.every((s) => s.key === upload.storageKey && s.ttlSeconds <= 900)).toBe(true);

    const updated = await Source.findById(source.id);
    expect(updated.status).toBe('completed');
    expect(updated.video.durationSeconds).toBe(900.5);
    expect((await Upload.findById(upload.id)).durationSeconds).toBe(900.5);
    expect((await Transcript.findOne({ source: source._id })).origin).toBe('uploaded_video');
  });

  test('videos over the duration limit fail permanently and the file is scheduled for deletion', async () => {
    const { source, job, upload } = await createUploadSource({ expiresAt: new Date(Date.now() + 7 * 86400000) });
    processingClient.probeVideo.mockRejectedValue(
      new ProcessingServiceError('This video is longer than the 180-minute limit.', { code: 'VIDEO_TOO_LONG', retryable: false })
    );

    await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);

    expect((await Source.findById(source.id)).error.code).toBe('VIDEO_TOO_LONG');
    const after = await Upload.findById(upload.id);
    expect(after.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600 * 1000 + 1000);
  });

  test('a missing file fails permanently with a clear message', async () => {
    const { source, job, upload } = await createUploadSource();
    await Upload.updateOne({ _id: upload._id }, { $set: { status: 'deleted' } });

    await expect(processJob(bullJob(job))).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await Source.findById(source.id)).error.code).toBe('VIDEO_UPLOAD_MISSING');
    expect(processingClient.probeVideo).not.toHaveBeenCalled();
  });

  test('retryable media errors keep the source in progress for BullMQ to retry', async () => {
    const { source, job } = await createUploadSource();
    processingClient.probeVideo.mockResolvedValue({ duration_seconds: 120, has_audio: true, has_video: true });
    processingClient.transcribeUploadedVideo.mockRejectedValue(
      new ProcessingServiceError('The uploaded video could not be read from storage.', { code: 'MEDIA_DOWNLOAD_FAILED', retryable: true })
    );

    await expect(processJob(bullJob(job, { attemptsMade: 0 }))).rejects.toThrow('could not be read');
    expect((await Source.findById(source.id)).status).toBe('transcribing');
    expect((await ProcessingJob.findById(job.id)).status).toBe('queued');
  });
});
