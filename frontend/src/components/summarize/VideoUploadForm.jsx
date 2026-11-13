import { Film } from 'lucide-react';
import Notice from '../common/Notice';
import FileUploadForm from './FileUploadForm';
import * as sourceService from '../../services/sourceService';
import { ACCEPTED_VIDEO_EXTENSIONS, ACCEPTED_VIDEO_MIME_TYPES } from '../../utils/contentTypes';
import { formatDuration, formatFileSize } from '../../utils/format';

const DURATION_PROBE_TIMEOUT_MS = 4000;

function extensionOf(name) {
  const match = /\.[^.]+$/.exec(name || '');
  return match ? match[0].toLowerCase() : '';
}

/**
 * Best-effort duration check in the browser (no upload needed). Returns null
 * when the browser can't decode the file (e.g. some MKV codecs); the server
 * enforces the limit regardless.
 */
export function readVideoDuration(file) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (value) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    const timer = setTimeout(() => done(null), DURATION_PROBE_TIMEOUT_MS);
    video.preload = 'metadata';
    video.onloadedmetadata = () => done(video.duration);
    video.onerror = () => done(null);
    video.src = url;
  });
}

export function validateVideoFile(file, config) {
  const ext = extensionOf(file.name);
  if (!ACCEPTED_VIDEO_EXTENSIONS.includes(ext)) return 'Choose an MP4, MOV, WEBM or MKV video file.';
  if (file.type && !file.type.startsWith('video/') && file.type !== 'application/octet-stream' && !ACCEPTED_VIDEO_MIME_TYPES.includes(file.type)) {
    return 'This file does not look like a video.';
  }
  if (file.size === 0) return 'The file is empty.';
  if (config && file.size > config.maxBytes) {
    return `The file is ${formatFileSize(file.size)}; the limit is ${formatFileSize(config.maxBytes)}.`;
  }
  return null;
}

async function inspectVideo(file, config) {
  const seconds = await readVideoDuration(file);
  if (!seconds) return {};
  const details = formatDuration(seconds);
  if (config && seconds > config.maxDurationMinutes * 60) {
    return { details, error: `The video is ${details} long; the limit is ${config.maxDurationMinutes} minutes.` };
  }
  return { details };
}

const LABELS = {
  drop: 'Drop a video here, or click to browse',
  hint: (config) =>
    `MP4, MOV, WEBM or MKV${config ? ` · up to ${formatFileSize(config.maxBytes)} and ${config.maxDurationMinutes} minutes` : ''}`,
  inputLabel: 'Choose a video file',
  choose: 'Choose a video file to upload.',
  submit: 'Upload and summarize',
  created: 'Video uploaded',
  createdDescription: 'Briefly is transcribing and summarizing it now.',
  note: (config) => `Files are private and deleted after ${config.retentionDays} days; the transcript and summary are kept.`,
};

const SETUP_NOTICE = (
  <Notice title="Video uploads aren't set up on this server">
    Uploaded videos are stored in object storage (such as Cloudflare R2 or S3), which has not been configured yet.
    An administrator needs to set the <code className="text-xs">STORAGE_*</code> variables in{' '}
    <code className="text-xs">backend/.env</code> (see the README). YouTube links and articles work without it.
  </Notice>
);

export default function VideoUploadForm() {
  return (
    <FileUploadForm
      loadConfig={sourceService.getUploadConfig}
      upload={sourceService.uploadVideo}
      validate={validateVideoFile}
      inspect={inspectVideo}
      accept={[...ACCEPTED_VIDEO_EXTENSIONS, ...ACCEPTED_VIDEO_MIME_TYPES].join(',')}
      icon={Film}
      labels={LABELS}
      setupNotice={SETUP_NOTICE}
    />
  );
}
