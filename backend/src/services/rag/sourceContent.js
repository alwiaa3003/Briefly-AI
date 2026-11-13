'use strict';

const Source = require('../../models/Source');
const Summary = require('../../models/Summary');
const Transcript = require('../../models/Transcript');
const DocumentPart = require('../../models/DocumentPart');
const config = require('../../config/env');
const { buildChunks } = require('./chunker');

/** Loads the stored content of an owned source (never re-fetches, re-transcribes or re-extracts). */
async function loadSourceContent(sourceId, userId) {
  const source = await Source.findOne({ _id: sourceId, user: userId }).select('+content');
  if (!source) return null;
  const [summary, transcript, parts] = await Promise.all([
    Summary.findOne({ source: source._id, user: userId }).lean(),
    source.kind === 'youtube' || source.kind === 'video'
      ? Transcript.findOne({ source: source._id, user: userId }).select('segments').lean()
      : null,
    source.kind === 'document'
      ? DocumentPart.find({ source: source._id, user: userId }).sort({ index: 1 }).lean()
      : null,
  ]);
  return {
    source,
    summary,
    content: { kind: source.kind, text: source.content, segments: transcript?.segments || [], parts: parts || [] },
  };
}

function sourceTitle(source, summary) {
  return source.metadata?.title || summary?.title || source.submittedUrl || 'Untitled';
}

/** Chunks for a loaded source using the configured size / overlap. */
function chunksFor({ content, summary }) {
  return buildChunks(
    { ...content, summary },
    { size: config.rag.chunkChars, overlap: config.rag.chunkOverlapChars, maxChunks: config.rag.maxChunksPerSource }
  );
}

module.exports = { loadSourceContent, sourceTitle, chunksFor };
