'use strict';

/**
 * Shared steps for video jobs (YouTube and uploads):
 *   transcribeInWindows -> summarizeTranscript
 *
 * Transcription is split into fixed windows (TRANSCRIPTION_CHUNK_SECONDS).
 * Each finished window is appended atomically together with its index, so a
 * retried job resumes where it stopped and never duplicates segments.
 */

const config = require('../../config/env');
const Source = require('../../models/Source');
const Summary = require('../../models/Summary');
const Transcript = require('../../models/Transcript');
const processingClient = require('../../services/processingClient');
const { summaryInputHash, reuseSummary } = require('../../services/ai/summaryCache');
const { ProcessingServiceError } = processingClient;
const { SOURCE_STATUSES } = require('../../queues/constants');
const { transcribeResultSchema, videoSummaryResultSchema } = require('../../validators/videoValidators');

function invalidResponse(code, message) {
  return new ProcessingServiceError(message, { code, retryable: false });
}

/** [{ index, start, end }] covering the whole video. Unknown duration -> one open-ended window. */
function planWindows(durationSeconds, chunkSeconds = config.video.transcriptionChunkSeconds) {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [{ index: 0, start: 0, end: null }];
  }
  const windows = [];
  for (let index = 0, start = 0; start < durationSeconds; index += 1, start += chunkSeconds) {
    windows.push({ index, start, end: Math.min(durationSeconds, start + chunkSeconds) });
  }
  // Fold a tiny trailing window (< 30 s) into the previous one to avoid a near-empty request.
  if (windows.length > 1 && windows[windows.length - 1].end - windows[windows.length - 1].start < 30) {
    const last = windows.pop();
    windows[windows.length - 1].end = last.end;
  }
  return windows;
}

function setStage(sourceId, status, progress = null) {
  return Source.updateOne({ _id: sourceId }, { $set: { status, error: null, progress } });
}

function countWords(segments) {
  return segments.reduce((sum, segment) => sum + (segment.text.match(/\S+/g)?.length ?? 0), 0);
}

/**
 * @param {object} params
 * @param {Source} params.source
 * @param {'youtube_video'|'uploaded_video'} params.origin
 * @param {number|null} params.durationSeconds
 * @param {(window) => Promise<object>} params.transcribeWindow  calls the processing service
 */
async function transcribeInWindows({ source, origin, durationSeconds, transcribeWindow }) {
  const windows = planWindows(durationSeconds);

  let transcript = await Transcript.findOneAndUpdate(
    { source: source._id },
    { $setOnInsert: { user: source.user, source: source._id, origin }, $set: { totalWindows: windows.length } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (!source.transcript) await Source.updateOne({ _id: source._id }, { $set: { transcript: transcript._id } });

  const done = new Set(transcript.completedWindows);
  await setStage(source._id, SOURCE_STATUSES.TRANSCRIBING, { current: done.size, total: windows.length });

  for (const window of windows) {
    if (done.has(window.index)) continue;

    const parsed = transcribeResultSchema.safeParse(await transcribeWindow(window));
    if (!parsed.success) throw invalidResponse('TRANSCRIPTION_INVALID_RESPONSE', 'The transcription result could not be used.');
    const result = parsed.data;

    // Only keep segments inside this window (the processing service already enforces this).
    const upper = window.end ?? Number.POSITIVE_INFINITY;
    const segments = result.segments
      .filter((s) => s.start >= window.start - 2 && s.start <= upper + 2)
      .map((s) => ({ start: s.start, end: Math.max(s.end, s.start), text: s.text, speaker: s.speaker || null }));

    await Transcript.updateOne(
      { _id: transcript._id, completedWindows: { $ne: window.index } },
      {
        $push: { segments: { $each: segments } },
        $addToSet: { completedWindows: window.index },
        $set: { provider: result.provider, model: result.model, ...(result.language && { language: result.language }) },
      }
    );
    done.add(window.index);
    await Source.updateOne({ _id: source._id }, { $set: { progress: { current: done.size, total: windows.length } } });
  }

  transcript = await Transcript.findById(transcript._id);
  const ordered = [...transcript.segments].sort((a, b) => a.start - b.start);
  if (ordered.length === 0) {
    throw new ProcessingServiceError('No speech could be detected in this video, so there is nothing to summarize.', {
      code: 'TRANSCRIPTION_NO_SPEECH',
      retryable: false,
    });
  }

  transcript.segments = ordered;
  transcript.wordCount = countWords(ordered);
  transcript.hasSpeakerLabels = ordered.some((s) => s.speaker);
  transcript.durationSeconds = durationSeconds || ordered[ordered.length - 1].end;
  transcript.completedAt = new Date();
  await transcript.save();
  return transcript;
}

async function summarizeTranscript({ source, transcript, sourceKind, title, channel, durationSeconds }) {
  const inputHash = summaryInputHash(sourceKind, [
    title || null,
    channel || null,
    transcript.segments.map((s) => [s.start, s.end, s.speaker || null, s.text]),
  ]);
  const cached = await reuseSummary(source, inputHash);
  if (cached) return cached;

  await setStage(source._id, SOURCE_STATUSES.SUMMARIZING);

  const parsed = videoSummaryResultSchema.safeParse(
    await processingClient.summarizeVideo({
      sourceKind,
      title,
      channel,
      durationSeconds,
      language: transcript.language,
      segments: transcript.segments.map((s) => (s.toObject ? s.toObject() : s)),
    })
  );
  if (!parsed.success) throw invalidResponse('AI_INVALID_RESPONSE', 'The summary result could not be used.');
  const { summary, model, prompt_version: promptVersion, input_truncated: inputTruncated, usage } = parsed.data;

  const saved = await Summary.findOneAndUpdate(
    { source: source._id },
    {
      $set: {
        user: source.user,
        title: summary.title,
        overview: summary.overview,
        sections: summary.sections,
        keyTakeaways: summary.key_takeaways,
        concepts: summary.concepts,
        mainArguments: summary.main_arguments,
        chapters: summary.chapters.map((c) => ({
          title: c.title,
          startSeconds: c.start_seconds,
          endSeconds: c.end_seconds,
          summary: c.summary,
        })),
        keyMoments: summary.key_moments.map((m) => ({ seconds: m.seconds, description: m.description })),
        model,
        promptVersion,
        inputHash,
        inputTruncated,
        inputCharacters: parsed.data.input_characters ?? null,
        usage: { inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null },
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );

  await Source.updateOne(
    { _id: source._id },
    {
      $set: {
        status: SOURCE_STATUSES.COMPLETED,
        summary: saved._id,
        completedAt: new Date(),
        error: null,
        failedAt: null,
        progress: null,
      },
    }
  );
  return saved;
}

async function markSourceFailed(sourceId, error) {
  await Source.updateOne(
    { _id: sourceId, status: { $ne: SOURCE_STATUSES.COMPLETED } },
    { $set: { status: SOURCE_STATUSES.FAILED, error, failedAt: new Date(), progress: null } }
  );
}

module.exports = { planWindows, transcribeInWindows, summarizeTranscript, markSourceFailed };
