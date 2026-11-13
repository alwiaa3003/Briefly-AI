'use strict';

const { z } = require('zod');

/** Defence-in-depth validation of processing-service video responses before persisting them. */

const text = (min, max) => z.string().trim().min(min).max(max);
const seconds = z.number().finite().nonnegative();

const segmentSchema = z.object({
  start: seconds,
  end: seconds,
  text: text(1, 2000),
  speaker: z.string().max(40).nullable().optional(),
});

const transcribeResultSchema = z.object({
  segments: z.array(segmentSchema).max(2000),
  language: z.string().max(35).nullable(),
  provider: text(1, 40),
  model: text(1, 100),
  clip_start: seconds,
  clip_end: seconds.nullable(),
});

const youtubeMetadataSchema = z.object({
  video_id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  watch_url: z.string().url().max(2048),
  title: z.string().max(300).nullable(),
  channel_title: z.string().max(200).nullable(),
  channel_url: z.string().url().max(2048).nullable(),
  thumbnail_url: z.string().url().max(2048).nullable(),
  duration_seconds: z.number().int().positive().nullable(),
  published_at: z.string().max(40).nullable(),
  privacy_status: z.string().max(20).nullable(),
  metadata_source: z.enum(['youtube_data_api', 'oembed']),
  captions: z.object({
    available: z.boolean().nullable(),
    manual_languages: z.array(z.string().max(20)).max(200),
    auto_languages: z.array(z.string().max(20)).max(200),
  }),
});

const probeResultSchema = z.object({
  duration_seconds: z.number().positive(),
  has_audio: z.boolean(),
  has_video: z.boolean(),
});

const videoSummaryResultSchema = z.object({
  summary: z.object({
    title: text(1, 300),
    overview: text(20, 1500),
    sections: z.array(z.object({ heading: text(1, 150), content: text(1, 6000) })).min(1).max(10),
    key_takeaways: z.array(text(1, 600)).min(1).max(8),
    concepts: z.array(z.object({ term: text(1, 120), explanation: text(1, 600) })).max(12),
    main_arguments: z.array(text(1, 600)).min(1).max(8),
    chapters: z
      .array(z.object({ title: text(1, 150), start_seconds: seconds, end_seconds: seconds.nullable(), summary: text(1, 1500) }))
      .min(1)
      .max(30),
    key_moments: z.array(z.object({ seconds, description: text(1, 300) })).max(15),
  }),
  model: text(1, 100),
  prompt_version: text(1, 50),
  input_truncated: z.boolean(),
  input_characters: z.number().int().nonnegative().optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().nullable().optional(),
      output_tokens: z.number().int().nonnegative().nullable().optional(),
    })
    .optional(),
});

module.exports = { transcribeResultSchema, youtubeMetadataSchema, probeResultSchema, videoSummaryResultSchema };
