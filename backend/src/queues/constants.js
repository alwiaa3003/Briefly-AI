'use strict';

/** Queue names. Each queue maps to a dedicated BullMQ worker. */
const QUEUE_NAMES = Object.freeze({
  PROCESSING: 'processing',
  // Scheduled housekeeping (expired upload cleanup). Not user-visible.
  MAINTENANCE: 'maintenance',
});

/**
 * Job types handled by the processing queue. Each needs a handler registered
 * in src/workers/handlers/index.js.
 */
const JOB_TYPES = Object.freeze({
  TEST: 'test',
  SUMMARIZE_ARTICLE: 'summarize_article',
  SUMMARIZE_YOUTUBE: 'summarize_youtube',
  SUMMARIZE_VIDEO_UPLOAD: 'summarize_video_upload',
  SUMMARIZE_DOCUMENT: 'summarize_document',
  // Milestone 5: retrieval index and study tools.
  INDEX_SOURCE: 'index_source',
  GENERATE_STUDY_NOTES: 'generate_study_notes',
  GENERATE_QUIZ: 'generate_quiz',
  GENERATE_FLASHCARDS: 'generate_flashcards',
  GENERATE_SUMMARY_STYLE: 'generate_summary_style',
});

/** Job types that produce a source's main summary (indexing for Ask AI follows them). */
const SUMMARY_JOB_TYPES = Object.freeze([
  JOB_TYPES.SUMMARIZE_ARTICLE,
  JOB_TYPES.SUMMARIZE_YOUTUBE,
  JOB_TYPES.SUMMARIZE_VIDEO_UPLOAD,
  JOB_TYPES.SUMMARIZE_DOCUMENT,
]);

/** Lifecycle of the retrieval index of a source (Source.rag.status). */
const RAG_STATUSES = Object.freeze({
  NONE: 'none',
  QUEUED: 'queued',
  INDEXING: 'indexing',
  READY: 'ready',
  FAILED: 'failed',
});

/** Lifecycle of generated study material (notes, quizzes, flashcards, summary styles). */
const GENERATION_STATUSES = Object.freeze({
  QUEUED: 'queued',
  GENERATING: 'generating',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const SUMMARY_STYLES = Object.freeze([
  'concise',
  'detailed',
  'bullet_points',
  'academic',
  'beginner',
  'technical',
  'exam_revision',
]);

const QUIZ_DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);
const QUESTION_TYPES = Object.freeze(['multiple_choice', 'true_false', 'short_answer']);

const MAINTENANCE_JOBS = Object.freeze({
  CLEANUP_UPLOADS: 'cleanup_uploads',
});

const JOB_STATUSES = Object.freeze({
  QUEUED: 'queued',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/** Kinds of content a user can summarize. */
const SOURCE_KINDS = Object.freeze({
  ARTICLE: 'article',
  YOUTUBE: 'youtube',
  VIDEO: 'video', // uploaded video file
  DOCUMENT: 'document', // uploaded PDF / DOCX / TXT
});

/** Lifecycle of a Source as shown to the user. */
const SOURCE_STATUSES = Object.freeze({
  QUEUED: 'queued',
  EXTRACTING: 'extracting', // articles / documents: reading the text (incl. OCR)
  PREPARING: 'preparing', // videos: metadata / probing the file
  TRANSCRIBING: 'transcribing', // videos: transcription windows
  SUMMARIZING: 'summarizing',
  COMBINING: 'combining', // long documents: merging per-chunk notes
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const SOURCE_IN_PROGRESS_STATUSES = Object.freeze([
  SOURCE_STATUSES.QUEUED,
  SOURCE_STATUSES.EXTRACTING,
  SOURCE_STATUSES.PREPARING,
  SOURCE_STATUSES.TRANSCRIBING,
  SOURCE_STATUSES.SUMMARIZING,
  SOURCE_STATUSES.COMBINING,
]);

/** Which job summarizes which kind of source. */
const JOB_TYPE_BY_KIND = Object.freeze({
  [SOURCE_KINDS.ARTICLE]: JOB_TYPES.SUMMARIZE_ARTICLE,
  [SOURCE_KINDS.YOUTUBE]: JOB_TYPES.SUMMARIZE_YOUTUBE,
  [SOURCE_KINDS.VIDEO]: JOB_TYPES.SUMMARIZE_VIDEO_UPLOAD,
  [SOURCE_KINDS.DOCUMENT]: JOB_TYPES.SUMMARIZE_DOCUMENT,
});

module.exports = {
  QUEUE_NAMES,
  JOB_TYPES,
  MAINTENANCE_JOBS,
  JOB_STATUSES,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  SOURCE_IN_PROGRESS_STATUSES,
  JOB_TYPE_BY_KIND,
  SUMMARY_JOB_TYPES,
  RAG_STATUSES,
  GENERATION_STATUSES,
  SUMMARY_STYLES,
  QUIZ_DIFFICULTIES,
  QUESTION_TYPES,
};
