import { FileText, Newspaper, Video, Youtube } from 'lucide-react';

/** Content types Briefly AI will support. Shared by the dashboard, summarize page and library filters. */
export const CONTENT_TYPES = [
  {
    id: 'article',
    label: 'Articles',
    singular: 'Article',
    description: 'Paste a link to a blog post, news story or long-form essay.',
    icon: Newspaper,
  },
  {
    id: 'youtube',
    label: 'YouTube',
    singular: 'YouTube video',
    description: 'Summarize a YouTube video with timestamps for key moments.',
    icon: Youtube,
  },
  {
    id: 'video',
    label: 'Videos',
    singular: 'Uploaded video',
    description: 'Upload a recording such as a lecture, meeting or interview.',
    icon: Video,
  },
  {
    id: 'document',
    label: 'Documents',
    singular: 'Document',
    description: 'Upload PDF, DOCX or TXT files: papers, reports and notes.',
    icon: FileText,
  },
];

/** Video files accepted by the video upload tab. */
export const ACCEPTED_VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv'];
export const ACCEPTED_VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'];

export const ACCEPTED_DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.txt'];
export const ACCEPTED_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

/** Content types that can be summarized. */
export const AVAILABLE_KINDS = ['article', 'youtube', 'video', 'document'];
