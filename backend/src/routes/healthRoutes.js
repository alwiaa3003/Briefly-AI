'use strict';

const express = require('express');
const healthController = require('../controllers/healthController');
const { asyncHandler } = require('../utils/http');

const router = express.Router();

router.get('/', healthController.liveness);
router.get('/ready', asyncHandler(healthController.readiness));

module.exports = router;
