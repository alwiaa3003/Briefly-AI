import { useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import Input from '../common/Input';
import Notice from '../common/Notice';
import SubmitRow from './SubmitRow';
import { useSubmitAndOpen } from './useSubmitAndOpen';
import * as sourceService from '../../services/sourceService';
import { getErrorMessage } from '../../utils/errors';
import { validateArticleUrl } from '../../utils/validation';

const URL_ERROR_CODES = new Set(['INVALID_URL', 'UNSAFE_URL', 'VALIDATION_ERROR']);

export default function ArticleForm({ autoFocus = false }) {
  const open = useSubmitAndOpen();
  const [url, setUrl] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (inFlight.current) return; // ignore repeated clicks / Enter presses
    setFormError('');

    const error = validateArticleUrl(url);
    setFieldError(error || '');
    if (error) return;

    inFlight.current = true;
    setSubmitting(true);
    try {
      const result = await sourceService.submitArticle(url.trim());
      open(result, { createdTitle: 'Article submitted', createdDescription: 'Briefly is reading and summarizing it now.' });
    } catch (err) {
      const code = err.response?.data?.error?.code;
      const message = getErrorMessage(err, 'The article could not be submitted. Please try again.');
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
        label="Article URL"
        type="url"
        inputMode="url"
        autoComplete="url"
        placeholder="https://example.com/long-read"
        leadingIcon={Link2}
        value={url}
        disabled={submitting}
        onChange={(event) => {
          setUrl(event.target.value);
          if (fieldError) setFieldError('');
        }}
        error={fieldError}
        hint="Paste a link to a publicly accessible article, such as a news story, blog post or essay."
        autoFocus={autoFocus}
      />
      <SubmitRow
        loading={submitting}
        label={submitting ? 'Submitting…' : 'Summarize article'}
        note="You'll get an overview, a detailed summary, key takeaways and concepts."
      />
    </form>
  );
}
