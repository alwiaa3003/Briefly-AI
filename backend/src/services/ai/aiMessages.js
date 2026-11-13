'use strict';

/**
 * User-facing wording for AI availability problems, per feature. The
 * processing service returns feature-neutral messages; this module says what
 * actually happens to *this* summary, chat answer or flashcard deck.
 */

const { humanDuration } = require('./aiGate');

const THING = Object.freeze({
  summary: 'summary',
  indexing: 'search index for this source',
  notes: 'study notes',
  quiz: 'quiz',
  flashcards: 'flashcards',
  style: 'summary style',
  chat: 'answer',
  search: 'search',
  other: 'request',
});

const thing = (feature) => THING[feature] || THING.other;
const when = (ms) => (ms ? ` in ${humanDuration(ms)}` : ' shortly');

/** A background job is paused (delayed retry) because of quota / rate limits / budgets. */
function deferredMessage(code, feature, retryAfterMs) {
  const t = thing(feature);
  switch (code) {
    case 'AI_QUOTA_EXHAUSTED':
      return `The free Gemini quota is used up for now. Your ${t} is paused and will continue automatically when quota is available${when(retryAfterMs)} (Google resets daily quotas; your AI Studio quota page shows the exact status).`;
    case 'AI_BUDGET_EXHAUSTED':
      return `Briefly's daily AI budget has been reached. Your ${t} is paused and will continue automatically${when(retryAfterMs)}, when the budget resets.`;
    case 'AI_RATE_LIMITED':
      return `Gemini is busy. Your ${t} will continue automatically${when(retryAfterMs)}.`;
    case 'AI_PACED':
    case 'AI_BUSY':
      return `Waiting for an AI slot. Your ${t} will continue automatically${when(retryAfterMs)}.`;
    default:
      return `Your ${t} will be retried automatically${when(retryAfterMs)}.`;
  }
}

/** A background job gave up waiting (bounded deferrals). */
function gaveUpMessage(code, feature) {
  const t = thing(feature);
  if (code === 'AI_BUDGET_EXHAUSTED') return `Your ${t} could not be generated because the AI budget stayed exhausted. Please try again later.`;
  return `Your ${t} could not be generated because Gemini stayed unavailable for too long. Please try again later.`;
}

/** Synchronous requests (Ask AI): what the user sees right away. */
function immediateMessage(code, feature, retryAfterMs) {
  const prefix = feature === 'chat' ? 'Ask AI can’t answer right now' : 'This can’t be done right now';
  const saved = ' Your saved summaries, notes and conversations are still available.';
  switch (code) {
    case 'AI_QUOTA_EXHAUSTED':
      return `${prefix}: the free Gemini quota is used up. Please try again later (your AI Studio quota page shows when it resets).${saved}`;
    case 'AI_BUDGET_EXHAUSTED':
      return `${prefix}: Briefly’s daily AI limit has been reached. It resets in ${humanDuration(retryAfterMs || 0)}.${saved}`;
    case 'AI_RATE_LIMITED':
    case 'AI_PACED':
    case 'AI_BUSY':
      return `${prefix}: Gemini is busy. Please try again${when(retryAfterMs)}.`;
    case 'AI_MODEL_UNAVAILABLE':
      return `${prefix}: the AI model configured on the server is not available. An administrator needs to check GEMINI_MODEL.${saved}`;
    case 'AI_NOT_CONFIGURED':
    case 'AI_CONFIGURATION_ERROR':
      return `${prefix}: AI features are not configured correctly on the server.${saved}`;
    default:
      return `${prefix}. Please try again.`;
  }
}

module.exports = { deferredMessage, gaveUpMessage, immediateMessage, thing };
