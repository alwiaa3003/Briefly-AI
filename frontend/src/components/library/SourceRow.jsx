import { Link } from 'react-router-dom';
import { Film, FileText, Newspaper, Youtube } from 'lucide-react';
import StatusBadge from '../summary/StatusBadge';
import { formatDuration, formatReadingTime, formatShortDate, getHostname } from '../../utils/format';
import { KIND_LABEL } from '../../utils/sourceStatus';

const KIND_ICON = { article: Newspaper, youtube: Youtube, video: Film, document: FileText };
const FORMAT_LABEL = { pdf: 'PDF', docx: 'Word', txt: 'Text' };

function Thumbnail({ item }) {
  const Icon = KIND_ICON[item.kind] ?? Newspaper;
  if (item.thumbnailUrl) {
    return (
      <span className="relative mt-0.5 block aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-stone-100 ring-1 ring-stone-200/70">
        <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-500">
      <Icon className="h-4 w-4" aria-hidden="true" />
    </span>
  );
}

/** One row in the library / recent-summaries lists: list-first, no heavy card. */
export default function SourceRow({ item, compact = false, showReady = false }) {
  const fallbackTitle =
    item.kind === 'article' ? getHostname(item.url) || 'Untitled article' : item.kind === 'document' ? 'Untitled document' : 'Untitled video';
  const title = item.title || fallbackTitle;
  const site =
    item.kind === 'youtube'
      ? item.author || null
      : item.kind === 'video'
        ? null
        : item.kind === 'document'
          ? [FORMAT_LABEL[item.format] || 'Document', item.pageCount ? `${item.pageCount} pages` : null].filter(Boolean).join(' · ')
          : item.siteName || getHostname(item.url);
  const duration =
    item.kind === 'youtube' || item.kind === 'video' ? formatDuration(item.durationSeconds) : formatReadingTime(item.wordCount);
  const transcribing = ['transcribing', 'extracting', 'summarizing'].includes(item.status) && item.progress?.total > 1;
  const showStatus = item.status !== 'completed';

  return (
    <li>
      <Link to={`/library/${item.id}`} className="list-row group flex items-start gap-4 rounded-lg px-3 py-4">
        <Thumbnail item={item} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <p className="line-clamp-2 font-serif text-[1.0625rem] font-medium leading-snug text-stone-900">{title}</p>
            <span className="shrink-0 pt-0.5 text-xs tabular-nums text-stone-500">{formatShortDate(item.createdAt)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
            <span className="font-medium text-stone-600">{KIND_LABEL[item.kind] ?? 'Source'}</span>
            {[site, duration].filter(Boolean).map((part) => (
              <span key={part} className="inline-flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className="text-stone-300">·</span>
                <span className="truncate">{part}</span>
              </span>
            ))}
            {showStatus && <StatusBadge status={item.status} />}
            {!showStatus && showReady && (
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="text-stone-300">·</span>
                <span className="inline-flex items-center gap-1.5 text-stone-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />
                  Summary ready
                </span>
              </span>
            )}
            {transcribing && (
              <span>
                part {Math.min(item.progress.current + 1, item.progress.total)} of {item.progress.total}
              </span>
            )}
          </div>
          {!compact && item.status === 'completed' && item.overview && (
            <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-stone-500">{item.overview}</p>
          )}
          {!compact && item.status === 'failed' && item.error?.message && (
            <p className="mt-2 line-clamp-2 text-sm text-red-700">{item.error.message}</p>
          )}
        </div>
      </Link>
    </li>
  );
}
