import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, Globe2, NotebookPen, RefreshCw } from 'lucide-react';
import { Card } from '../common/Card';
import Button from '../common/Button';
import Skeleton from '../common/Skeleton';
import SourceRefs from '../ai/SourceRefs';
import { FailedGeneration, GeneratingState, NotGeneratedState } from '../ai/GenerationState';
import { usePolling } from '../../hooks/usePolling';
import { useToast } from '../../hooks/useToast';
import * as aiService from '../../services/aiService';
import { getErrorMessage } from '../../utils/errors';
import { downloadText, isGenerating, notesToMarkdown, slugify } from '../../utils/study';

function Section({ title, children, hidden }) {
  if (hidden) return null;
  return (
    <section className="border-t border-stone-200/70 pt-5">
      <h3 className="eyebrow mb-3">{title}</h3>
      {children}
    </section>
  );
}

function Terms({ items }) {
  return (
    <dl className="space-y-3">
      {items.map((t) => (
        <div key={t.term}>
          <dt className="text-sm font-semibold text-stone-900">{t.term}</dt>
          <dd className="mt-0.5 text-sm leading-relaxed text-stone-700">
            {t.explanation}
            <SourceRefs refs={t.refs} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Items({ items, mono = false }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={`${i}-${item.text.slice(0, 20)}`} className="flex gap-2.5 text-sm leading-relaxed text-stone-700">
          <span className="mt-[0.6rem] h-1 w-1 shrink-0 rounded-full bg-stone-400" aria-hidden="true" />
          <span className={mono ? 'whitespace-pre-wrap font-mono text-[0.8rem]' : undefined}>
            {item.text}
            <SourceRefs refs={item.refs} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function StudyNotesPanel({ source }) {
  const toast = useToast();
  const [notes, setNotes] = useState(undefined);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setNotes(await aiService.getNotes(source.id));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [source.id]);

  useEffect(() => {
    load();
  }, [load]);
  usePolling(load, isGenerating(notes));

  async function generate(regenerate = false) {
    setBusy(true);
    try {
      setNotes(await aiService.generateNotes(source.id, { regenerate }));
    } catch (err) {
      toast.error('Could not generate notes', getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const title = source.summary?.title || source.metadata?.title;
  async function copy() {
    try {
      await navigator.clipboard.writeText(notesToMarkdown(notes, title));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Notes copied', 'Paste them anywhere as Markdown.');
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access.');
    }
  }

  let body;
  if (notes === undefined && !error) {
    body = (
      <div className="space-y-3 p-6" role="status" aria-label="Loading notes">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  } else if (error && notes === undefined) {
    body = <FailedGeneration item={{ error: { message: getErrorMessage(error) } }} onRetry={load} what="Could not load study notes" />;
  } else if (!notes) {
    body = (
      <NotGeneratedState
        icon={NotebookPen}
        title="Study notes"
        description="Structured notes with key concepts, definitions, facts, examples and revision points, each linked to where it comes from."
        actionLabel="Generate study notes"
        onGenerate={() => generate()}
        busy={busy}
      />
    );
  } else if (isGenerating(notes)) {
    body = <GeneratingState title="Writing your study notes…" item={notes} />;
  } else if (notes.status === 'failed') {
    body = <FailedGeneration item={notes} onRetry={() => generate(true)} busy={busy} what="The notes could not be generated" />;
  } else {
    body = (
      <div className="space-y-5 p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {notes.stale && (
              <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                This source has changed since these notes were made. Regenerate to update them.
              </p>
            )}
            <h2 className="font-serif text-[1.625rem] font-medium leading-tight text-stone-900">{notes.title}</h2>
            <p className="mt-3 font-serif text-[1.125rem] leading-[1.7] text-stone-800">{notes.overview}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => downloadText(`${slugify(notes.title)}-notes.md`, notesToMarkdown(notes, title))}
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Export
            </Button>
            <Button variant="ghost" size="sm" onClick={() => generate(true)} loading={busy}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Regenerate
            </Button>
          </div>
        </div>
        <Section title="Key concepts" hidden={!notes.keyConcepts?.length}>
          <Terms items={notes.keyConcepts} />
        </Section>
        <Section title="Definitions" hidden={!notes.definitions?.length}>
          <Terms items={notes.definitions} />
        </Section>
        <Section title="Key facts" hidden={!notes.keyFacts?.length}>
          <Items items={notes.keyFacts} />
        </Section>
        <Section title="Examples" hidden={!notes.examples?.length}>
          <Items items={notes.examples} />
        </Section>
        <Section title="Formulas and technical details" hidden={!notes.formulas?.length}>
          <Items items={notes.formulas} mono />
        </Section>
        <Section title="Revision points" hidden={!notes.revisionPoints?.length}>
          <Items items={notes.revisionPoints} />
        </Section>
        {notes.externalKnowledge?.length > 0 && (
          <section aria-label="Background knowledge" className="rounded-lg border border-amber-200 bg-amber-50/60 p-4">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800">
              <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
              Background, not from this source
            </h3>
            <p className="mt-1 text-xs text-amber-800">General knowledge the AI added for context. Verify before relying on it.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-700">
              {notes.externalKnowledge.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  return <Card>{body}</Card>;
}
