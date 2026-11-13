'use strict';

const { z } = require('zod');

/**
 * Defence-in-depth validation of the summary returned by the processing
 * service before it is written to MongoDB. The Python service already
 * validates Gemini's output; this guards the database contract independently.
 */
const text = (min, max) => z.string().trim().min(min).max(max);

const summaryResultSchema = z.object({
  summary: z.object({
    title: text(1, 300),
    overview: text(20, 1500),
    sections: z.array(z.object({ heading: text(1, 150), content: text(1, 6000) })).min(1).max(10),
    key_takeaways: z.array(text(1, 600)).min(1).max(8),
    concepts: z.array(z.object({ term: text(1, 120), explanation: text(1, 600) })).max(12),
    main_arguments: z.array(text(1, 600)).min(1).max(8),
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

const extractResultSchema = z.object({
  final_url: z.string().max(2048),
  canonical_url: z.string().max(2048),
  title: z.string().max(300).nullable(),
  author: z.string().max(300).nullable(),
  published_at: z.string().max(40).nullable(),
  site_name: z.string().max(200).nullable(),
  description: z.string().max(1000).nullable(),
  language: z.string().max(35).nullable(),
  content: z.string().min(1),
  word_count: z.number().int().nonnegative(),
  content_truncated: z.boolean(),
});

module.exports = { summaryResultSchema, extractResultSchema };
