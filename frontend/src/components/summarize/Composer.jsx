import { FileText, Newspaper, Upload, Youtube } from 'lucide-react';
import { TabList } from '../common/Tabs';
import { cn } from '../../utils/cn';
import ArticleForm from './ArticleForm';
import YouTubeForm from './YouTubeForm';
import VideoUploadForm from './VideoUploadForm';
import DocumentUploadForm from './DocumentUploadForm';

/** Input methods. Ids are the `?source=` values used across the app. */
export const SOURCES = [
  { id: 'article', label: 'Article URL', shortLabel: 'Article', icon: Newspaper, hint: 'Paste a link to a blog post, news story or essay.' },
  { id: 'youtube', label: 'YouTube URL', shortLabel: 'YouTube', icon: Youtube, hint: 'Public YouTube videos, including Shorts. Chapters and timestamps included.' },
  { id: 'upload', label: 'Upload video', shortLabel: 'Video', icon: Upload, hint: 'Lectures, meetings or interviews. Briefly transcribes the audio.' },
  { id: 'document', label: 'Document', shortLabel: 'Document', icon: FileText, hint: 'PDF, Word (.docx) or text files, including scanned PDFs.' },
];

export function resolveSource(id) {
  return SOURCES.some((source) => source.id === id) ? id : 'article';
}

/**
 * The single place where content enters Briefly: a method picker and the matching form
 * (each form keeps its own validation, upload progress and processing status).
 */
export default function Composer({ value, onChange, idPrefix = '', className, autoFocus = false }) {
  const active = resolveSource(value);
  const current = SOURCES.find((source) => source.id === active);
  return (
    <div className={cn('rounded-lg border border-stone-200 bg-white', className)}>
      <div className="px-5 pt-2 sm:px-7">
        <TabList label="Source type" tabs={SOURCES} value={active} onChange={onChange} idPrefix={idPrefix} className="border-stone-200/70" />
      </div>
      <div role="tabpanel" id={`${idPrefix}panel-${active}`} aria-labelledby={`${idPrefix}tab-${active}`} className="px-5 pb-6 pt-5 sm:px-7 sm:pb-7">
        <p className="mb-4 text-sm text-stone-500">{current.hint}</p>
        {active === 'article' && <ArticleForm autoFocus={autoFocus} />}
        {active === 'youtube' && <YouTubeForm autoFocus={autoFocus} />}
        {active === 'upload' && <VideoUploadForm />}
        {active === 'document' && <DocumentUploadForm />}
      </div>
    </div>
  );
}
