'use strict';

/**
 * Summary cache: a summary is reused (no Gemini request) when its source's
 * extracted content and the summary configuration are unchanged.
 *
 * The key is a hash of the content that is sent to the summarizer plus
 * SUMMARY_CACHE_VERSION (bump it when prompts or summary formats change, which
 * invalidates every cached summary). Lookups are always scoped to the same
 * source and user, so one user's cached content can never reach another user.
 * Alternative summary styles are cached separately (SummaryVariant, per style).
 */

const crypto = require('crypto');
const Summary = require('../../models/Summary');
const Source = require('../../models/Source');
const { SOURCE_STATUSES } = require('../../queues/constants');

const SUMMARY_CACHE_VERSION = 'summary-cache-v1';

function summaryInputHash(kind, payload) {
  return crypto.createHash('sha256').update(JSON.stringify([SUMMARY_CACHE_VERSION, kind, payload])).digest('hex');
}

/** If this source already has a summary for exactly this input, marks the source completed and returns it. */
async function reuseSummary(source, inputHash) {
  const existing = await Summary.findOne({ source: source._id, user: source.user, inputHash });
  if (!existing) return null;
  await Source.updateOne(
    { _id: source._id },
    {
      $set: {
        status: SOURCE_STATUSES.COMPLETED,
        summary: existing._id,
        completedAt: new Date(),
        error: null,
        failedAt: null,
        progress: null,
      },
    }
  );
  return existing;
}

module.exports = { summaryInputHash, reuseSummary, SUMMARY_CACHE_VERSION };
