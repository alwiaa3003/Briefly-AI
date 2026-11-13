import { formatDuration, formatPublishedDate, formatTimestamp } from './format';

function metaLine(source) {
  const { metadata = {}, video = {} } = source;
  if (source.kind === 'youtube') {
    return [video?.channelTitle || metadata.author, formatPublishedDate(video?.publishedAt), formatDuration(video?.durationSeconds)];
  }
  if (source.kind === 'video') return [source.upload?.originalName, formatDuration(video?.durationSeconds)];
  if (source.kind === 'document') {
    const doc = source.document || {};
    return [source.upload?.originalName, doc.author && `By ${doc.author}`, doc.pageCount && `${doc.pageCount} pages`];
  }
  return [metadata.author && `By ${metadata.author}`, metadata.siteName, formatPublishedDate(metadata.publishedAt)];
}

/** " (p. 3, 5)" or " (§ Methods)" for document references. */
function refText(ref) {
  if (!ref) return '';
  const parts = [];
  if (ref.pages?.length) parts.push(`${ref.pages.length > 1 ? 'pp.' : 'p.'} ${ref.pages.join(', ')}`);
  if (ref.section) parts.push(`§ ${ref.section}`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

/** Builds a Markdown version of a summary for copying to the clipboard. */
export function summaryToMarkdown(source) {
  const { summary } = source;
  if (!summary) return '';

  const lines = [`# ${summary.title}`, ''];
  const meta = metaLine(source).filter(Boolean).join(' · ');
  if (meta) lines.push(`_${meta}_`, '');
  if (source.kind !== 'video' && source.kind !== 'document' && source.url) lines.push(`Source: ${source.url}`, '');
  const refs = summary.references || {};

  lines.push('## Overview', '', summary.overview, '');

  if (summary.chapters?.length) {
    lines.push('## Chapters', '', ...summary.chapters.map((c) => `- **${formatTimestamp(c.startSeconds)}** ${c.title}: ${c.summary}`), '');
  }

  if (summary.sections?.length) {
    lines.push('## Summary', '');
    for (const section of summary.sections) {
      lines.push(`### ${section.heading}`, '', section.content, '');
    }
  }

  if (summary.sectionBreakdown?.length) {
    lines.push('## Section by section', '');
    for (const s of summary.sectionBreakdown) lines.push(`### ${s.title}${refText(s)}`, '', s.summary, '');
  }

  if (summary.keyTakeaways?.length) {
    lines.push('## Key takeaways', '', ...summary.keyTakeaways.map((point, i) => `- ${point}${refText(refs.keyTakeaways?.[i])}`), '');
  }

  if (summary.keyMoments?.length) {
    lines.push('## Key moments', '', ...summary.keyMoments.map((m) => `- **${formatTimestamp(m.seconds)}** ${m.description}`), '');
  }

  if (summary.facts?.length) {
    lines.push('## Facts and figures', '', ...summary.facts.map((f) => `- ${f.statement}${refText(f)}`), '');
  }

  if (summary.mainArguments?.length) {
    lines.push('## Main arguments and conclusions', '', ...summary.mainArguments.map((point, i) => `- ${point}${refText(refs.mainArguments?.[i])}`), '');
  }

  if (summary.concepts?.length) {
    lines.push('## Key concepts', '', ...summary.concepts.map((c, i) => `- **${c.term}**: ${c.explanation}${refText(refs.concepts?.[i])}`), '');
  }

  return `${lines.join('\n').trim()}\n`;
}
