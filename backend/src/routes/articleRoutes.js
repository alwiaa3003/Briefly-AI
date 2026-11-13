'use strict';

const express = require('express');
const sourceController = require('../controllers/sourceController');
const { requireAuth } = require('../middleware/auth');
const { articleLimiter } = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const { submitArticleSchema } = require('../validators/sourceValidators');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

router.post('/', requireAuth, articleLimiter, validate({ body: submitArticleSchema }), asyncHandler(sourceController.submitArticle));

module.exports = router;
