import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import Markdown from '../common/Markdown';
import { Card } from '../common/Card';
import Button from '../common/Button';
import { FailedGeneration, GeneratingState } from '../ai/GenerationState';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import * as aiService from '../../services/aiService';
import { getErrorMessage } from '../../utils/errors';
import { SUMMARY_STYLES, isGenerating, styledSummaryToMarkdown } from '../../utils/study';

export function StyleSelect({ value, onChange }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-stone-600">
      <span>Style</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="control h-8 w-auto pr-8 text-sm"
      >
        {SUMMARY_STYLES.map((s) => (
          <option key={s.id} value={s.id} title={s.description}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The summary rewritten in another style; generated on first use from stored content (no reprocessing). */
export function StyledSummary({ source, style }) {
  const toast = useToast();
  const [item, setItem] = useState(undefined);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(
    async (regenerate = false) => {
      setBusy(true);
      try {
        setItem(await aiService.generateSummaryStyle(source.id, style, { regenerate }));
        setError(null);
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
    },
    [source.id, style]
  );

  const load = useCallback(async () => {
    try {
      const existing = await aiService.getSummaryStyle(source.id, style);
      if (existing) setItem(existing);
      else await generate();
    } catch (err) {
      setError(err);
    }
  }, [source.id, style, generate]);

  useEffect(() => {
    setItem(undefined);
    setError(null);
    load();
  }, [load]);
  usePolling(async () => setItem(await aiService.getSummaryStyle(source.id, style)), isGenerating(item));

  const label = SUMMARY_STYLES.find((s) => s.id === style)?.label;

  if (error && !item) {
    return (
      <Card>
        <FailedGeneration item={{ error: { message: getErrorMessage(error) } }} onRetry={() => generate()} busy={busy} what={`The ${label} summary could not be created`} />
      </Card>
    );
  }
  if (!item || isGenerating(item)) {
    return (
      <Card>
        <GeneratingState
          title={`Rewriting the summary: ${label}`}
          description="Uses the content already saved, so the source is not processed again."
          item={item}
        />
      </Card>
    );
  }
  if (item.status === 'failed') {
    return (
      <Card>
        <FailedGeneration item={item} onRetry={() => generate(true)} busy={busy} what={`The ${label} summary could not be created`} />
      </Card>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(styledSummaryToMarkdown(item));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access.');
    }
  }

  return (
    <article className="max-w-reading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="eyebrow text-brand-600">{label}</p>
          <h2 className="mt-2 font-serif text-[1.625rem] font-medium leading-tight text-stone-900">{item.title}</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => generate(true)} loading={busy}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Regenerate
          </Button>
        </div>
      </div>
      <p className="mt-5 font-serif text-[1.1875rem] leading-[1.7] text-stone-800">{item.overview}</p>
      <div className="mt-8 space-y-8">
        {item.sections.map((s) => (
          <section key={s.heading}>
            <h3 className="font-serif text-xl font-medium text-stone-900">{s.heading}</h3>
            <Markdown text={s.content} className="reading mt-2.5" />
          </section>
        ))}
      </div>
      {item.keyPoints?.length > 0 && (
        <section className="mt-9 border-t border-stone-200/70 pt-6">
          <h3 className="eyebrow mb-3">Key points</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-stone-700">
            {item.keyPoints.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
