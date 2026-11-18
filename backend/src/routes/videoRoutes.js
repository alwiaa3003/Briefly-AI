'use strict';

const express = require('express');
const sourceController = require('../controllers/sourceController');
const { requireAuth } = require('../middleware/auth');
const { articleLimiter, uploadLimiter } = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const { submitYouTubeSchema } = require('../validators/sourceValidators');
const { startDirectUploadSchema, uploadIdParams } = require('../validators/uploadValidators');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

router.use(requireAuth);

router.get('/uploads/config', sourceController.getUploadConfig);
// Summaries of any kind share the per-user hourly budget (articleLimiter).
router.post('/youtube', articleLimiter, validate({ body: submitYouTubeSchema }), asyncHandler(sourceController.submitYouTube));
// Multipart body: not parsed by express.json(); streamed by the upload service.
router.post('/uploads', uploadLimiter, articleLimiter, asyncHandler(sourceController.uploadVideo));

// Direct uploads: the file goes from the browser straight to object storage.
// Starting one counts against the same upload + summary budgets as a streamed upload.
router.post('/uploads/direct', uploadLimiter, articleLimiter, validate({ body: startDirectUploadSchema }), asyncHandler(sourceController.directVideoUpload.start));
router.post('/uploads/direct/:uploadId/complete', validate({ params: uploadIdParams }), asyncHandler(sourceController.directVideoUpload.complete));
router.delete('/uploads/direct/:uploadId', validate({ params: uploadIdParams }), asyncHandler(sourceController.directVideoUpload.cancel));

module.exports = router;
