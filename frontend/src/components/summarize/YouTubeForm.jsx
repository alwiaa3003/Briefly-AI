import { useRef, useState } from 'react';
import { Link2, Youtube } from 'lucide-react';
import Input from '../common/Input';
import Notice from '../common/Notice';
import SubmitRow from './SubmitRow';
import { useSubmitAndOpen } from './useSubmitAndOpen';
import * as sourceService from '../../services/sourceService';
import { getErrorMessage } from '../../utils/errors';
import { parseYouTubeLink, youtubeThumbnail } from '../../utils/youtube';

const URL_ERROR_CODES = new Set(['INVALID_YOUTUBE_URL', 'VALIDATION_ERROR']);

/** Preview from the video id alone; title, channel and duration are fetched server-side after submission. */
function VideoPreview({ videoId }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <div className="flex items-center gap-4 rounded-lg border border-stone-200 bg-stone-50/60 p-3">
      <div className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-md bg-stone-200">
        {!imageFailed ? (
          <img
            src={youtubeThumbnail(videoId)}
            alt="Video thumbnail"
            className="h-full w-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <Youtube className="absolute inset-0 m-auto h-6 w-6 text-stone-400" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 text-sm">
        <p className="font-medium text-stone-900">YouTube video</p>
        <p className="mt-0.5 font-mono text-xs text-stone-500">ID {videoId}</p>
        <p className="mt-1 text-xs text-stone-500">Title, channel and duration are loaded when you submit.</p>
      </div>
    </div>
  );
}

export default function YouTubeForm({ autoFocus = false }) {
  const open = useSubmitAndOpen();
  const [url, setUrl] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  const parsed = url.trim() ? parseYouTubeLink(url) : null;

  async function handleSubmit(event) {
    event.preventDefault();
    if (inFlight.current) return;
    setFormError('');

    const result = parseYouTubeLink(url);
    if (result.error) {
      setFieldError(result.error);
      return;
    }
    setFieldError('');
    inFlight.current = true;
    setSubmitting(true);
    try {
      const response = await sourceService.submitYouTube(url.trim());
      open(response, { createdTitle: 'Video submitted', createdDescription: 'Briefly is transcribing and summarizing it now.' });
    } catch (err) {
      const code = err.response?.data?.error?.code;
      const message = getErrorMessage(err, 'The video could not be submitted. Please try again.');
      if (URL_ERROR_CODES.has(code)) setFieldError(message);
      else setFormError(message);
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-5" aria-busy={submitting || undefined}>
      {formError && <Notice variant="error">{formError}</Notice>}
      <Input
        label="YouTube video URL"
        type="url"
        inputMode="url"
        placeholder="https://www.youtube.com/watch?v=…"
        leadingIcon={Link2}
        value={url}
        disabled={submitting}
        onChange={(event) => {
          setUrl(event.target.value);
          if (fieldError) setFieldError('');
        }}
        error={fieldError}
        hint="Public videos only. Links to watch pages, youtu.be, Shorts and embeds all work."
        autoFocus={autoFocus}
      />
      {parsed?.videoId && <VideoPreview videoId={parsed.videoId} />}
      <SubmitRow
        loading={submitting}
        label={submitting ? 'Submitting…' : 'Summarize video'}
        note="You'll get chapters with timestamps, key moments, a summary and a searchable transcript."
      />
    </form>
  );
}
