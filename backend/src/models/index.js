'use strict';

/**
 * Model registry. See docs/ARCHITECTURE.md ("Database design").
 */

module.exports = {
  User: require('./User'),
  RefreshToken: require('./RefreshToken'),
  ProcessingJob: require('./ProcessingJob'),
  Source: require('./Source'),
  Summary: require('./Summary'),
  Upload: require('./Upload'),
  Transcript: require('./Transcript'),
  DocumentPart: require('./DocumentPart'),
  DocumentChunk: require('./DocumentChunk'),
  // Milestone 5: retrieval, Ask AI and study tools.
  ContentChunk: require('./ContentChunk'),
  Conversation: require('./Conversation'),
  Message: require('./Message'),
  StudyNote: require('./StudyNote'),
  Quiz: require('./Quiz'),
  QuizAttempt: require('./QuizAttempt'),
  FlashcardDeck: require('./FlashcardDeck'),
  SummaryVariant: require('./SummaryVariant'),
  UserPreference: require('./UserPreference'),
};
