import { ExternalLink } from 'lucide-react';
import StatusBadge from './StatusBadge';
import { buttonClasses } from '../common/Button';
import {
  formatDuration,
  formatPublishedDate,
  formatReadingTime,
  getHostname,
  safeExternalUrl,
} from '../../utils/format';
import { KIND_LABEL } from '../../utils/sourceStatus';

function metaItems(source) {
  const { metadata = {}, video = {}, kind } = source;
  if (kind === 'youtube') {
    return [video?.channelTitle || metadata.author, formatPublishedDate(video?.publishedAt), formatDuration(video?.durationSeconds)];
  }
  if (kind === 'video') {
    return [source.upload?.originalName, formatDuration(video?.durationSeconds)];
  }
  if (kind === 'document') {
    const doc = source.document || {};
    return [
      { pdf: 'PDF', docx: 'Word document', txt: 'Text file' }[doc.format],
      doc.author && `By ${doc.author}`,
      doc.pageCount ? `${doc.pageCount} ${doc.pageCount === 1 ? 'page' : 'pages'}` : null,
      doc.wordCount ? `${doc.wordCount.toLocaleString()} words` : null,
    ];
  }
  return [
    metadata.siteName || getHostname(source.url),
    metadata.author && `By ${metadata.author}`,
    formatPublishedDate(metadata.publishedAt),
    formatReadingTime(metadata.wordCount),
  ];
}

export default function SourceHeader({ source, actions }) {
  const { metadata = {} } = source;
  const fallback = source.kind === 'article' ? getHostname(source.url) || 'Article' : source.kind === 'document' ? 'Document' : 'Video';
  const title = source.summary?.title || metadata.title || fallback;
  const meta = metaItems(source).filter(Boolean);
  const externalUrl = source.kind === 'video' || source.kind === 'document' ? null : safeExternalUrl(source.url);

  return (
    <header className="mb-10 max-w-4xl border-b border-stone-200 pb-8">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow">{KIND_LABEL[source.kind] ?? 'Source'}</span>
        <StatusBadge status={source.status} />
      </div>
      <h1 className="mt-3 font-serif text-[2.125rem] font-medium leading-[1.1] tracking-[-0.015em] text-stone-900 sm:text-[2.75rem] lg:text-[3.125rem]">
        {title}
      </h1>
      {meta.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone-500">
          {meta.map((item, index) => (
            <span key={item} className="inline-flex items-center gap-2">
              {index > 0 && <span aria-hidden="true" className="text-stone-300">·</span>}
              {item}
            </span>
          ))}
        </p>
      )}
      {(externalUrl || actions) && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={buttonClasses({ variant: 'secondary', size: 'sm' })}
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              {source.kind === 'youtube' ? 'Open on YouTube' : 'Open original'}
            </a>
          )}
          {actions}
        </div>
      )}
    </header>
  );
}
