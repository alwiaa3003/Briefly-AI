'use strict';

const { buildChunks, sampleChunks, splitLong, formatTime } = require('../src/services/rag/chunker');

const opts = { size: 200, overlap: 40, maxChunks: 100 };
const sentence = (i) => `Sentence number ${i} talks about urban trees and cooling. `;

describe('chunker', () => {
  test('articles are grouped by paragraph within the size limit', () => {
    const text = Array.from({ length: 10 }, (_, i) => sentence(i).repeat(2)).join('\n\n');
    const chunks = buildChunks({ kind: 'article', text }, opts);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(opts.size + 2);
      expect(c.chunkType).toBe('content');
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  test('long paragraphs are split at sentence boundaries', () => {
    const pieces = splitLong(sentence(1).repeat(10), 150);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 150)).toBe(true);
    expect(pieces[0].endsWith('.')).toBe(true);
  });

  test('transcript chunks keep exact segment timestamps and labels', () => {
    const segments = Array.from({ length: 12 }, (_, i) => ({ start: i * 30, end: i * 30 + 28, text: sentence(i) }));
    const chunks = buildChunks({ kind: 'youtube', segments }, { ...opts, overlap: 80 });
    expect(chunks[0].startSeconds).toBe(0);
    expect(chunks[0].label).toBe(`0:00–${formatTime(chunks[0].endSeconds)}`);
    for (const c of chunks) {
      expect(segments.some((s) => s.start === c.startSeconds)).toBe(true);
      expect(segments.some((s) => s.end === c.endSeconds)).toBe(true);
    }
    // overlap: a later chunk starts before the previous one ends
    expect(chunks[1].startSeconds).toBeLessThan(chunks[0].endSeconds);
  });

  test('document chunks never span pages and carry page / section', () => {
    const parts = [1, 2, 3].map((page) => ({
      index: page - 1,
      page,
      headingPath: ['Results'],
      blocks: [
        { kind: 'heading', text: `Heading ${page}` },
        { kind: 'paragraph', text: sentence(page).repeat(3) },
      ],
    }));
    const chunks = buildChunks({ kind: 'document', parts }, opts);
    const pages = chunks.map((c) => c.page);
    expect(new Set(pages)).toEqual(new Set([1, 2, 3]));
    expect(chunks.every((c) => c.label === `p. ${c.page}`)).toBe(true);
    expect(chunks.find((c) => c.page === 2).section).toBe('Heading 2');
  });

  test('docx parts without pages use section labels', () => {
    const parts = [{ index: 0, page: null, headingPath: ['Methods'], blocks: [{ kind: 'paragraph', text: sentence(1) }] }];
    const [chunk] = buildChunks({ kind: 'document', parts }, opts);
    expect(chunk.label).toBe('Methods');
    expect(chunk.page).toBeNull();
  });

  test('a summary chunk is appended and maxChunks is respected', () => {
    const text = Array.from({ length: 40 }, (_, i) => sentence(i)).join('\n\n');
    const summary = { title: 'Trees', overview: 'Trees cool cities.', keyTakeaways: ['Shade helps.'], concepts: [] };
    const chunks = buildChunks({ kind: 'article', text, summary }, { ...opts, maxChunks: 3 });
    expect(chunks).toHaveLength(4);
    expect(chunks[3]).toMatchObject({ chunkType: 'summary', label: 'Summary', index: 3 });
  });

  test('sampleChunks spreads a budget across the whole source in order', () => {
    const chunks = Array.from({ length: 20 }, (_, i) => ({ text: 'x'.repeat(100), index: i }));
    const sample = sampleChunks(chunks, 500);
    expect(sample.length).toBeGreaterThanOrEqual(4);
    expect(sample.reduce((n, c) => n + c.text.length, 0)).toBeLessThanOrEqual(500);
    expect(sample[sample.length - 1].index).toBeGreaterThan(15);
    expect(sampleChunks(chunks.slice(0, 3), 500)).toHaveLength(3);
  });
});
