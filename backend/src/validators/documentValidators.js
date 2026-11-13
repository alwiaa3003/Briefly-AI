'use strict';

const { z } = require('zod');

/** Defence-in-depth validation of processing-service document responses before persisting them. */

const text = (min, max) => z.string().trim().min(min).max(max);
const pages = z.array(z.number().int().positive()).max(12);
const section = z.string().max(300).nullable().optional();

const blockSchema = z.object({
  kind: z.enum(['heading', 'paragraph', 'list', 'table']),
  text: text(1, 60000),
  level: z.number().int().min(1).max(6).nullable().optional(),
});

const partSchema = z.object({
  index: z.number().int().nonnegative(),
  page: z.number().int().positive().nullable(),
  heading_path: z.array(z.string().max(300)).max(6),
  blocks: z.array(blockSchema).max(5000),
  needs_ocr: z.boolean(),
  char_count: z.number().int().nonnegative(),
});

const extractionSchema = z.object({
  format: z.enum(['pdf', 'docx', 'txt']),
  metadata: z.object({
    title: z.string().max(300).nullable().optional(),
    author: z.string().max(300).nullable().optional(),
    subject: z.string().max(300).nullable().optional(),
    keywords: z.string().max(300).nullable().optional(),
    created: z.string().max(40).nullable().optional(),
    modified: z.string().max(40).nullable().optional(),
    encoding: z.string().max(40).nullable().optional(),
  }),
  page_count: z.number().int().nonnegative().nullable(),
  pages_processed: z.number().int().nonnegative().nullable(),
  char_count: z.number().int().nonnegative(),
  word_count: z.number().int().nonnegative(),
  parts: z.array(partSchema).max(20000),
  ocr_pages: z.array(z.number().int().positive()),
  truncated: z.boolean(),
  warnings: z.array(z.string().max(500)).max(20),
});

const ocrSchema = z.object({
  pages: z.array(z.object({ page: z.number().int().positive(), blocks: z.array(blockSchema).max(2000) })),
  provider: text(1, 40),
  model: text(1, 100),
});

const refText = z.object({ text: text(1, 800), pages, section });
const refFact = z.object({ statement: text(1, 800), pages, section });
const refDefinition = z.object({ term: text(1, 150), explanation: text(1, 800), pages, section });
const refSection = z.object({ title: text(1, 200), summary: text(1, 3000), pages, section });

const notesSchema = z.object({
  sections: z.array(refSection).max(20),
  key_points: z.array(refText).max(20),
  facts: z.array(refFact).max(25),
  definitions: z.array(refDefinition).max(20),
  arguments: z.array(refText).max(12),
});

const chunkResultSchema = z.object({
  notes: notesSchema,
  model: text(1, 100),
  references_discarded: z.number().int().nonnegative(),
  usage: z.object({ input_tokens: z.number().nullable().optional(), output_tokens: z.number().nullable().optional() }),
});

const summaryResultSchema = z.object({
  summary: z.object({
    title: text(1, 300),
    overview: text(20, 2500),
    sections: z.array(z.object({ heading: text(1, 200), content: text(1, 8000) })).min(1).max(12),
    section_breakdown: z.array(refSection).min(1).max(40),
    key_takeaways: z.array(refText).min(1).max(10),
    concepts: z.array(refDefinition).max(15),
    facts: z.array(refFact).max(20),
    main_arguments: z.array(refText).min(1).max(10),
  }),
  model: text(1, 100),
  prompt_version: text(1, 50),
  mode: z.enum(['direct', 'combine']),
  input_characters: z.number().int().nonnegative(),
  references_discarded: z.number().int().nonnegative(),
  merge_rounds: z.number().int().nonnegative(),
  usage: z.object({ input_tokens: z.number().nullable().optional(), output_tokens: z.number().nullable().optional() }),
});

module.exports = { extractionSchema, ocrSchema, chunkResultSchema, summaryResultSchema };
