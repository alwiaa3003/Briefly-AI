'use strict';

const express = require('express');
const sourceController = require('../controllers/sourceController');
const { requireAuth } = require('../middleware/auth');
const { articleLimiter, uploadLimiter } = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const { startDirectUploadSchema, uploadIdParams } = require('../validators/uploadValidators');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

router.use(requireAuth);

router.get('/uploads/config', sourceController.getDocumentUploadConfig);
// Multipart body: streamed by the upload service. Shares the upload + summary budgets.
router.post('/uploads', uploadLimiter, articleLimiter, asyncHandler(sourceController.uploadDocument));

// Direct uploads: the file goes from the browser straight to object storage.
// Starting one counts against the same upload + summary budgets as a streamed upload.
router.post('/uploads/direct', uploadLimiter, articleLimiter, validate({ body: startDirectUploadSchema }), asyncHandler(sourceController.directDocumentUpload.start));
router.post('/uploads/direct/:uploadId/complete', validate({ params: uploadIdParams }), asyncHandler(sourceController.directDocumentUpload.complete));
router.delete('/uploads/direct/:uploadId', validate({ params: uploadIdParams }), asyncHandler(sourceController.directDocumentUpload.cancel));

module.exports = router;
