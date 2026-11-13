'use strict';

const express = require('express');
const sourceController = require('../controllers/sourceController');
const { requireAuth } = require('../middleware/auth');
const { articleLimiter, uploadLimiter } = require('../middleware/rateLimiters');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

router.use(requireAuth);

router.get('/uploads/config', sourceController.getDocumentUploadConfig);
// Multipart body: streamed by the upload service. Shares the upload + summary budgets.
router.post('/uploads', uploadLimiter, articleLimiter, asyncHandler(sourceController.uploadDocument));

module.exports = router;
