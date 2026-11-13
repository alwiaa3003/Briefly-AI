'use strict';

const { JOB_TYPES, SUMMARY_JOB_TYPES } = require('../../queues/constants');
const handleTestJob = require('./testJobHandler');
const handleSummarizeArticle = require('./articleSummaryHandler');
const handleSummarizeYouTube = require('./youtubeSummaryHandler');
const handleSummarizeVideoUpload = require('./videoUploadHandler');
const handleSummarizeDocument = require('./documentSummaryHandler');
const handleIndexSource = require('./indexSourceHandler');
const { makeStudyHandler } = require('./studyHandlers');
const { scheduleAfterSummary } = require('../../services/rag/indexService');

/**
 * Maps a job type to its handler. A handler receives
 * `{ input, processingJobId, attempt }` and returns a JSON-serializable result.
 * It may define `handler.onFinalFailure({ input, processingJobId, error })`,
 * which runs once when the job fails permanently, and
 * `handler.onCompleted({ input, result })`, which runs after success (best effort).
 *
 * To add a job type: add it to JOB_TYPES, write a handler, register it here.
 */
const handlers = Object.freeze({
  [JOB_TYPES.TEST]: handleTestJob,
  [JOB_TYPES.SUMMARIZE_ARTICLE]: handleSummarizeArticle,
  [JOB_TYPES.SUMMARIZE_YOUTUBE]: handleSummarizeYouTube,
  [JOB_TYPES.SUMMARIZE_VIDEO_UPLOAD]: handleSummarizeVideoUpload,
  [JOB_TYPES.SUMMARIZE_DOCUMENT]: handleSummarizeDocument,
  [JOB_TYPES.INDEX_SOURCE]: handleIndexSource,
  [JOB_TYPES.GENERATE_STUDY_NOTES]: makeStudyHandler(JOB_TYPES.GENERATE_STUDY_NOTES),
  [JOB_TYPES.GENERATE_QUIZ]: makeStudyHandler(JOB_TYPES.GENERATE_QUIZ),
  [JOB_TYPES.GENERATE_FLASHCARDS]: makeStudyHandler(JOB_TYPES.GENERATE_FLASHCARDS),
  [JOB_TYPES.GENERATE_SUMMARY_STYLE]: makeStudyHandler(JOB_TYPES.GENERATE_SUMMARY_STYLE),
});

// Every completed summary is indexed for Ask AI and smart search (RAG_AUTO_INDEX).
const indexAfterSummary = ({ input, result }) => scheduleAfterSummary({ sourceId: result?.sourceId || input?.sourceId });
for (const type of SUMMARY_JOB_TYPES) handlers[type].onCompleted = indexAfterSummary;

function getJobHandler(type) {
  return Object.prototype.hasOwnProperty.call(handlers, type) ? handlers[type] : null;
}

module.exports = { getJobHandler };
