'use strict';

const { z } = require('zod');

const createTestJobSchema = z.object({
  message: z
    .string({ invalid_type_error: 'Message must be a string.' })
    .trim()
    .min(1, 'Message cannot be empty.')
    .max(500, 'Message must be at most 500 characters.')
    .default('Hello from Briefly AI'),
});

const jobIdParamsSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid job id.'),
});

module.exports = { createTestJobSchema, jobIdParamsSchema };
