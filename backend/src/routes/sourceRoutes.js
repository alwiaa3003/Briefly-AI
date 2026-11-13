'use strict';

const express = require('express');
const sourceController = require('../controllers/sourceController');
const { requireAuth } = require('../middleware/auth');
const { articleLimiter } = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const { listSourcesQuerySchema, sourceIdParamsSchema, documentTextQuerySchema, originalQuerySchema } = require('../validators/sourceValidators');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

router.use(requireAuth);

const withId = validate({ params: sourceIdParamsSchema });

router.get('/', validate({ query: listSourcesQuerySchema }), asyncHandler(sourceController.listSources));
router.get('/stats', asyncHandler(sourceController.getStats));
router.get('/:id', withId, asyncHandler(sourceController.getSource));
router.get('/:id/transcript', withId, asyncHandler(sourceController.getTranscript));
router.get('/:id/playback', withId, asyncHandler(sourceController.getPlayback));
router.get('/:id/original', validate({ params: sourceIdParamsSchema, query: originalQuerySchema }), asyncHandler(sourceController.getOriginal));
router.get('/:id/document-text', validate({ params: sourceIdParamsSchema, query: documentTextQuerySchema }), asyncHandler(sourceController.getDocumentText));
// Retrying costs AI calls, so it shares the submission rate limit.
router.post('/:id/retry', articleLimiter, withId, asyncHandler(sourceController.retrySource));

module.exports = router;
