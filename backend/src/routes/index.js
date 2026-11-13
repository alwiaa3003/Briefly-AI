'use strict';

const express = require('express');
const ai = require('./aiRoutes');

const router = express.Router();

router.use('/health', require('./healthRoutes'));
router.use('/auth', require('./authRoutes'));
router.use('/jobs', require('./jobRoutes'));
router.use('/articles', require('./articleRoutes'));
router.use('/videos', require('./videoRoutes'));
router.use('/documents', require('./documentRoutes'));
router.use('/sources', require('./sourceRoutes'));
// Milestone 5: Ask AI, smart search and study tools.
router.use('/sources', ai.sourceStudy);
router.use('/conversations', ai.conversations);
router.use('/search', ai.search);
router.use('/quizzes', ai.quizzes);
router.use('/flashcards', ai.flashcards);
router.use('/preferences', ai.preferences);
router.use('/usage', ai.usage);

module.exports = router;
