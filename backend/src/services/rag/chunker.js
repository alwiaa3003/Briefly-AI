'use strict';

/**
 * Splits a source into retrievable chunks that keep their location metadata:
 *   articles   -> paragraphs grouped to ~RAG_CHUNK_CHARS
 *   transcripts-> consecutive segments, with start/end seconds
 *   documents  -> blocks of one page (PDF) or one section (DOCX/TXT), with page/section
 * plus one "summary" chunk built from the generated summary (useful for broad questions).
 *
 * Pure functions: no database access, easy to test.
 */

const MAX_CHUNK_TEXT = 8000;

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Splits text longer than `size` at sentence boundaries, then hard-wraps what is still too long. */
function splitLong(text, size) {
  if (text.length <= size) return [text];
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+|\n|$)\s*/g) || [text];
  const pieces = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > size) {
      pieces.push(current.trim());
      current = '';
    }
    if (sentence.length > size) {
      for (let i = 0; i < sentence.length; i += size) pieces.push(sentence.slice(i, i + size).trim());
    } else {
      current += sentence;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces.filter(Boolean);
}

/**
 * Groups units ({ text, ...meta }) into chunks of about `size` characters.
 * `boundary(prev, next)` forces a new chunk (e.g. at a page change).
 * Overlap repeats trailing units of the previous chunk (whole units only, so metadata stays exact).
 */
function groupUnits(units, { size, overlap, boundary = () => false }) {
  const expanded = [];
  for (const unit of units) {
    const clean = (unit.text || '').replace(/[ \t]+/g, ' ').trim();
    if (!clean) continue;
    for (const piece of splitLong(clean, size)) expanded.push({ ...unit, text: piece });
  }

  const groups = [];
  let current = [];
  let length = 0;
  const flush = (withOverlap) => {
    if (!current.length) return;
    groups.push(current);
    let carried = [];
    if (withOverlap && overlap > 0) {
      let total = 0;
      for (let i = current.length - 1; i > 0; i -= 1) {
        total += current[i].text.length;
        if (total > overlap) break;
        carried = [current[i], ...carried];
      }
    }
    current = carried;
    length = carried.reduce((n, u) => n + u.text.length + 1, 0);
  };

  for (const unit of expanded) {
    const last = current[current.length - 1];
    if (last && boundary(last, unit)) flush(false);
    else if (current.length && length + unit.text.length > size) flush(true);
    current.push(unit);
    length += unit.text.length + 1;
  }
  flush(false);
  return groups;
}

function articleChunks(content, opts) {
  const paragraphs = String(content || '')
    .split(/\n\s*\n/)
    .map((text) => ({ text }));
  return groupUnits(paragraphs, opts).map((group) => ({
    text: group.map((u) => u.text).join('\n\n'),
    label: null,
  }));
}

function transcriptChunks(segments, opts) {
  const units = (segments || []).map((s) => ({ text: s.text, start: s.start, end: s.end, speaker: s.speaker }));
  return groupUnits(units, { ...opts, separator: ' ' }).map((group) => {
    const start = group[0].start;
    const end = group[group.length - 1].end;
    return {
      text: group.map((u) => (u.speaker ? `${u.speaker}: ${u.text}` : u.text)).join(' '),
      label: `${formatTime(start)}–${formatTime(end)}`,
      startSeconds: start,
      endSeconds: end,
    };
  });
}

function documentChunks(parts, opts) {
  const units = [];
  for (const part of parts || []) {
    const section = part.headingPath?.length ? part.headingPath[part.headingPath.length - 1] : null;
    let currentSection = section;
    for (const block of part.blocks || []) {
      if (block.kind === 'heading') currentSection = block.text.slice(0, 300);
      units.push({ text: block.text, page: part.page ?? null, section: currentSection, part: part.index });
    }
  }
  const boundary = (prev, next) =>
    prev.page !== null || next.page !== null ? prev.page !== next.page : prev.section !== next.section;
  return groupUnits(units, { ...opts, boundary }).map((group) => {
    const { page } = group[0];
    const section = group.find((u) => u.section)?.section || null;
    const label = page ? `p. ${page}` : section ? section.slice(0, 120) : `Part ${group[0].part + 1}`;
    return { text: group.map((u) => u.text).join('\n'), label, page, section };
  });
}

function summaryChunk(summary) {
  if (!summary) return null;
  const lines = [summary.title, summary.overview];
  for (const t of summary.keyTakeaways || []) lines.push(`- ${t}`);
  for (const c of summary.concepts || []) lines.push(`${c.term}: ${c.explanation}`);
  const text = lines.filter(Boolean).join('\n').slice(0, MAX_CHUNK_TEXT);
  return text.trim() ? { text, label: 'Summary', chunkType: 'summary' } : null;
}

/**
 * Builds the chunk list for a source. `content` is one of
 *   { kind: 'article', text } | { kind: 'youtube'|'video', segments } | { kind: 'document', parts }
 */
function buildChunks({ kind, text, segments, parts, summary }, { size, overlap, maxChunks }) {
  const opts = { size, overlap };
  let chunks;
  if (kind === 'article') chunks = articleChunks(text, opts);
  else if (kind === 'youtube' || kind === 'video') chunks = transcriptChunks(segments, opts);
  else chunks = documentChunks(parts, opts);

  chunks = chunks
    .map((c) => ({ chunkType: 'content', ...c, text: c.text.slice(0, MAX_CHUNK_TEXT) }))
    .filter((c) => c.text.trim().length >= 20);
  if (chunks.length > maxChunks) chunks = chunks.slice(0, maxChunks);
  const extra = summaryChunk(summary);
  if (extra) chunks.push(extra);
  return chunks.map((c, index) => ({ ...c, index }));
}

/**
 * Picks an evenly spread, in-order selection of chunks within a character budget,
 * so study tools see the whole source (beginning, middle and end) without sending all of it.
 */
function sampleChunks(chunks, maxChars) {
  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  if (total <= maxChars) return chunks;
  const keepRatio = maxChars / total;
  const selected = [];
  let budget = 0;
  let used = 0;
  for (const chunk of chunks) {
    budget += chunk.text.length * keepRatio;
    if (used + chunk.text.length <= budget && used + chunk.text.length <= maxChars) {
      selected.push(chunk);
      used += chunk.text.length;
    }
  }
  return selected.length ? selected : chunks.slice(0, 1);
}

module.exports = { buildChunks, sampleChunks, splitLong, groupUnits, formatTime };
