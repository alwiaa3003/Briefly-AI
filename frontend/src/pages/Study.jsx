import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, ArrowUpRight, ClipboardList, Layers, NotebookPen, Search } from 'lucide-react';
import PageContainer from '../components/layout/PageContainer';
import { TabList } from '../components/common/Tabs';
import EmptyState from '../components/common/EmptyState';
import Input from '../components/common/Input';
import Button, { ButtonLink } from '../components/common/Button';
import Spinner from '../components/common/Spinner';
import SourceListSkeleton from '../components/library/SourceListSkeleton';
import StudyNotesPanel from '../components/study/StudyNotesPanel';
import FlashcardsPanel from '../components/study/FlashcardsPanel';
import QuizPanel from '../components/study/QuizPanel';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import * as sourceService from '../services/sourceService';
import { cn } from '../utils/cn';
import { getErrorMessage } from '../utils/errors';
import { formatShortDate, getHostname } from '../utils/format';
import { KIND_LABEL } from '../utils/sourceStatus';

/**
 * One study workspace: pick a tool (Notes / Flashcards / Quizzes), pick a source,
 * and work on it right here. The same panels also live on each source's page.
 */
const TOOLS = [
  {
    id: 'notes',
    label: 'Notes',
    icon: NotebookPen,
    tab: 'notes',
    Panel: StudyNotesPanel,
    intro: 'Structured notes for a source: overview, key concepts, definitions, facts and revision points, each linked to where it comes from.',
  },
  {
    id: 'flashcards',
    label: 'Flashcards',
    icon: Layers,
    tab: 'flashcards',
    Panel: FlashcardsPanel,
    intro: 'Revision cards for the essentials of a source. Flip, shuffle and mark what you already know.',
  },
  {
    id: 'quizzes',
    label: 'Quizzes',
    icon: ClipboardList,
    tab: 'quiz',
    Panel: QuizPanel,
    intro: 'Multiple-choice, true/false and short-answer questions grounded in the source, scored with explanations.',
  },
];

const PAGE_SIZE = 20;

function titleFor(item) {
  return item.title || item.summary?.title || item.metadata?.title || getHostname(item.url) || 'Untitled';
}

function SourcePicker({ tool, selectedId, onSelect }) {
  const [query, setQuery] = useState('');
  const search = useDebouncedValue(query.trim(), 300);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const result = await sourceService.listSources({ status: 'completed', search: search || undefined, page, limit: PAGE_SIZE });
      if (id === requestId.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (id === requestId.current) setError(err);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [search, page]);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => setPage(1), [search]);

  let body;
  if (loading && !data) {
    body = <SourceListSkeleton rows={4} />;
  } else if (error && !data) {
    body = (
      <EmptyState
        icon={AlertCircle}
        title="Could not load your sources"
        description={getErrorMessage(error)}
        action={
          <Button variant="secondary" size="sm" onClick={load}>
            Try again
          </Button>
        }
      />
    );
  } else if (!data.items.length) {
    body = search ? (
      <EmptyState icon={Search} title="No matching sources" description="Try a different title, site or URL." />
    ) : (
      <EmptyState
        icon={tool.icon}
        title="Nothing to study yet"
        description="Study material is created from summarized sources. Summarize an article, video or document first."
        action={
          <ButtonLink to="/summarize" variant="secondary" size="sm">
            Summarize something
          </ButtonLink>
        }
      />
    );
  } else {
    body = (
      <>
        <ul className="divide-y divide-stone-200/70" aria-busy={loading || undefined}>
          {data.items.map((item) => {
            const selected = item.id === selectedId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  aria-current={selected ? 'true' : undefined}
                  className={cn(
                    'group relative block w-full py-3.5 pl-4 pr-2 text-left transition-colors',
                    selected ? 'bg-white' : 'hover:bg-white/60'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn('absolute inset-y-2 left-0 w-0.5 rounded-full', selected ? 'bg-brand-500' : 'bg-transparent')}
                  />
                  <span className="line-clamp-2 font-serif text-[1rem] font-medium leading-snug text-stone-900">{titleFor(item)}</span>
                  <span className="mt-1 block text-xs text-stone-500">
                    {KIND_LABEL[item.kind] ?? 'Source'} · {formatShortDate(item.createdAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {data.totalPages > 1 && (
          <div className="flex items-center justify-between gap-2 border-t border-stone-200 py-3 text-xs text-stone-500">
            <span>
              Page {data.page} of {data.totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div>
      <Input
        aria-label="Find a source"
        type="search"
        placeholder="Find a source"
        leadingIcon={Search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        maxLength={100}
      />
      <h2 className="eyebrow mt-6 border-b border-stone-200 pb-2.5">Sources ready to study</h2>
      {body}
    </div>
  );
}

function SelectedSource({ sourceId, tool, onClear }) {
  const [source, setSource] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    setSource(null);
    try {
      setSource(await sourceService.getSource(sourceId));
    } catch (err) {
      setError(err);
    }
  }, [sourceId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="Could not open this source"
        description={getErrorMessage(error)}
        action={
          <Button variant="secondary" size="sm" onClick={load}>
            Try again
          </Button>
        }
      />
    );
  }
  if (!source) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-stone-500" role="status">
        <Spinner /> Opening source…
      </div>
    );
  }

  const { Panel } = tool;
  return (
    <article aria-labelledby="study-source-title">
      <button type="button" onClick={onClear} className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-900 lg:hidden">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All sources
      </button>
      <header className="mb-8 border-b border-stone-200 pb-6">
        <p className="eyebrow mb-2">
          {tool.label} · {KIND_LABEL[source.kind] ?? 'Source'}
        </p>
        <h2 id="study-source-title" className="font-serif text-2xl font-medium leading-tight text-stone-900 sm:text-[1.875rem]">
          {titleFor(source)}
        </h2>
        <Link
          to={`/library/${source.id}`}
          className="mt-3 inline-flex items-center gap-1 text-sm text-stone-500 underline-offset-4 hover:text-stone-900 hover:underline"
        >
          Read the summary
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </header>
      {source.status === 'completed' ? (
        <Panel key={`${tool.id}-${source.id}`} source={source} />
      ) : (
        <p className="text-sm text-stone-500">This source has not finished summarizing yet, so study material is not available.</p>
      )}
    </article>
  );
}

export default function Study() {
  const [params, setParams] = useSearchParams();
  const tool = TOOLS.find((t) => t.id === params.get('tool')) || TOOLS[0];
  const sourceId = params.get('source');

  function update(next) {
    const merged = { tool: tool.id, ...(sourceId ? { source: sourceId } : {}), ...next };
    Object.keys(merged).forEach((key) => (merged[key] === null || merged[key] === undefined) && delete merged[key]);
    setParams(merged, { replace: true });
  }

  return (
    <PageContainer eyebrow="Study" title="Study workspace" description="Turn what you have read into notes, flashcards and quizzes.">
      <TabList label="Study tools" tabs={TOOLS} value={tool.id} onChange={(id) => update({ tool: id })} />
      <div role="tabpanel" id={`panel-${tool.id}`} aria-labelledby={`tab-${tool.id}`} className="pt-6">
        <p className="mb-8 max-w-2xl text-sm leading-relaxed text-stone-500">{tool.intro}</p>
        <div className="grid gap-10 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-14">
          <aside aria-label="Choose a source" className={cn(sourceId && 'hidden lg:block')}>
            <SourcePicker tool={tool} selectedId={sourceId} onSelect={(id) => update({ source: id })} />
          </aside>
          <section aria-label={`${tool.label} workspace`} className={cn('min-w-0', !sourceId && 'hidden lg:block')}>
            {sourceId ? (
              <SelectedSource sourceId={sourceId} tool={tool} onClear={() => update({ source: null })} />
            ) : (
              <div className="flex min-h-[16rem] flex-col items-start justify-center border-l border-stone-200 pl-10">
                <p className="font-serif text-2xl font-medium text-stone-900">Choose a source to begin.</p>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-stone-500">
                  {tool.label} open here, beside your list, so you can move between sources without losing your place.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </PageContainer>
  );
}
