'use strict';

const { z } = require('zod');

/** POST /api/{videos|documents}/uploads/direct — what the browser declares about the file. */
const startDirectUploadSchema = z
  .object({
    fileName: z.string().trim().min(1, 'A file name is required.').max(300),
    sizeBytes: z.number().int('The file size is invalid.').nonnegative('The file size is invalid.').max(Number.MAX_SAFE_INTEGER),
    // Browsers may report an empty type for some files; the policy decides what is acceptable.
    mimeType: z.string().max(200).optional().default(''),
  })
  .strict();

const uploadIdParams = z.object({ uploadId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid upload id.') });

module.exports = { startDirectUploadSchema, uploadIdParams };
