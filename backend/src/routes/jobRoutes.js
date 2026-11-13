'use strict';

const express = require('express');
const jobController = require('../controllers/jobController');
const { requireAuth } = require('../middleware/auth');
const { jobLimiter } = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const { createTestJobSchema, jobIdParamsSchema } = require('../validators/jobValidators');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

router.use(requireAuth);

router.post('/test', jobLimiter, validate({ body: createTestJobSchema }), asyncHandler(jobController.createTestJob));
router.get('/:id', validate({ params: jobIdParamsSchema }), asyncHandler(jobController.getJob));

module.exports = router;
