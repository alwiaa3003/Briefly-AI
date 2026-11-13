'use strict';

/**
 * Smart library search: natural-language queries over the user's own content.
 * Combines semantic chunk retrieval, keyword chunk matches and title matches,
 * groups results by source and returns previews with locations.
 */

const Source = require('../models/Source');
const Summary = require('../models/Summary');
const { retrieve } = require('./rag/retrieval');
const aiGate = require('./ai/aiGate');
const config = require('../config/env');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dayRange(from, to) {
  return {
    from: from ? new Date(`${from}T00:00:00.000Z`) : undefined,
    to: to ? new Date(`${to}T23:59:59.999Z`) : undefined,
  };
}

async function search({ userId, q, kind, from, to, limit = 10 }) {
  const range = dayRange(from, to);
  const kinds = kind ? [kind] : undefined;

  const titleFilter = { user: userId, $or: [{ 'metadata.title': new RegExp(escapeRegex(q), 'i') }] };
  if (kind) titleFilter.kind = kind;
  if (range.from || range.to) {
    titleFilter.createdAt = {};
    if (range.from) titleFilter.createdAt.$gte = range.from;
    if (range.to) titleFilter.createdAt.$lte = range.to;
  }

  const [{ chunks, mode }, titleMatches] = await Promise.all([
    aiGate.runWithAiContext({ feature: 'search', userId: String(userId) }, () =>
      retrieve({
        userId,
        query: q,
        kinds,
        from: range.from,
        to: range.to,
        limit: Math.min(40, limit * 4),
        minScore: config.rag.searchMinScore,
      })
    ),
    Source.find(titleFilter).sort({ createdAt: -1 }).limit(limit).select('_id').lean(),
  ]);

  // Rank sources by their best chunk (fused rank score), then title-only matches.
  const bySource = new Map();
  chunks.forEach((chunk, rank) => {
    const key = String(chunk.source);
    const entry = bySource.get(key) || { score: 0, matches: [] };
    entry.score = Math.max(entry.score, chunk.score || 0);
    if (entry.matches.length < 2) {
      entry.matches.push({
        snippet: chunk.text.slice(0, 260),
        label: chunk.label || null,
        page: chunk.page ?? null,
        startSeconds: chunk.startSeconds ?? null,
        section: chunk.section ?? null,
        chunkType: chunk.chunkType,
        relevance: chunk.semanticScore === null || chunk.semanticScore === undefined ? null : Math.round(chunk.semanticScore * 1000) / 1000,
        rank,
      });
    }
    bySource.set(key, entry);
  });
  for (const match of titleMatches) {
    const key = String(match._id);
    const entry = bySource.get(key) || { score: 0, matches: [] };
    entry.titleMatch = true;
    entry.score += 1 / 61;
    bySource.set(key, entry);
  }

  const ids = [...bySource.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit).map(([id]) => id);
  const [sources, summaries] = await Promise.all([
    Source.find({ _id: { $in: ids }, user: userId }).select('kind metadata status createdAt video document rag').lean(),
    Summary.find({ source: { $in: ids }, user: userId }).select('source title overview').lean(),
  ]);
  const sourceById = new Map(sources.map((s) => [String(s._id), s]));
  const summaryBySource = new Map(summaries.map((s) => [String(s.source), s]));

  const results = ids
    .filter((id) => sourceById.has(id))
    .map((id) => {
      const s = sourceById.get(id);
      const summary = summaryBySource.get(id);
      const entry = bySource.get(id);
      return {
        source: {
          id,
          kind: s.kind,
          title: s.metadata?.title || summary?.title || 'Untitled',
          status: s.status,
          createdAt: s.createdAt,
          siteName: s.metadata?.siteName || null,
          thumbnailUrl: s.video?.thumbnailUrl || null,
        },
        overview: summary?.overview ? summary.overview.slice(0, 240) : null,
        matches: entry.matches.map(({ rank: _rank, ...m }) => m),
        titleMatch: Boolean(entry.titleMatch),
      };
    });

  return { query: q, mode, results, topK: config.rag.topK, minScore: mode === 'hybrid' ? config.rag.searchMinScore : null };
}

module.exports = { search };
