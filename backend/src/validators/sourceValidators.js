'use strict';

const { z } = require('zod');
const { SOURCE_KINDS, SOURCE_STATUSES } = require('../queues/constants');
const { MAX_URL_LENGTH } = require('../utils/articleUrl');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id.');

const submitArticleSchema = z.object({
  url: z
    .string({ required_error: 'Enter an article URL.', invalid_type_error: 'The URL must be a string.' })
    .trim()
    .min(1, 'Enter an article URL.')
    .max(MAX_URL_LENGTH, 'The URL is too long.'),
});

const submitYouTubeSchema = z.object({
  url: z
    .string({ required_error: 'Enter a YouTube link.', invalid_type_error: 'The URL must be a string.' })
    .trim()
    .min(1, 'Enter a YouTube link.')
    .max(MAX_URL_LENGTH, 'The URL is too long.'),
});

const sourceIdParamsSchema = z.object({ id: objectId });

const listSourcesQuerySchema = z.object({
  search: z.string().trim().max(100, 'Search is too long.').optional().transform((value) => value || undefined),
  kind: z.enum(Object.values(SOURCE_KINDS)).optional(),
  status: z.enum([...Object.values(SOURCE_STATUSES), 'processing']).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const documentTextQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const originalQuerySchema = z.object({ download: z.enum(['0', '1', 'true', 'false']).optional() });

module.exports = {
  submitArticleSchema,
  submitYouTubeSchema,
  sourceIdParamsSchema,
  listSourcesQuerySchema,
  documentTextQuerySchema,
  originalQuerySchema,
};
