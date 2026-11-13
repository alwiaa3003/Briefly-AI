import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, Library as LibraryIcon, Plus, Search, Sparkles } from 'lucide-react';
import PageContainer from '../components/layout/PageContainer';
import EmptyState from '../components/common/EmptyState';
import Input, { Select } from '../components/common/Input';
import { Segmented } from '../components/common/Tabs';
import Button, { ButtonLink } from '../components/common/Button';
import SourceRow from '../components/library/SourceRow';
import SourceListSkeleton from '../components/library/SourceListSkeleton';
import SmartSearchResults from '../components/library/SmartSearchResults';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import * as sourceService from '../services/sourceService';
import { cn } from '../utils/cn';
import { CONTENT_TYPES } from '../utils/contentTypes';
import { getErrorMessage } from '../utils/errors';
import { isInProgress } from '../utils/sourceStatus';

const TYPE_FILTERS = [{ id: 'all', label: 'All' }, ...CONTENT_TYPES.map(({ id, label }) => ({ id, label }))];

const STATUS_FILTERS = [
  { id: '', label: 'Any status' },
  { id: 'completed', label: 'Ready' },
  { id: 'processing', label: 'Processing' },
  { id: 'failed', label: 'Failed' },
];

const SORTS = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'title', label: 'Title A–Z' },
];

function titleOf(item) {
  return (item.title || item.siteName || item.url || '').toLocaleLowerCase();
}

/** Sorts the loaded page. The API returns newest first; other orders apply within the page. */
function sortItems(items, sort) {
  if (sort === 'newest') return items;
  const copy = [...items];
  if (sort === 'oldest') copy.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (sort === 'title') copy.sort((a, b) => titleOf(a).localeCompare(titleOf(b)));
  return copy;
}

const PAGE_SIZE = 20;
const REFRESH_WHILE_PROCESSING_MS = 4000;

export default function Library() {
  const [searchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(urlQuery);
  const [sort, setSort] = useState('newest');

  // The top-bar search opens /library?q=…; follow it when it changes.
  useEffect(() => {
    setQuery(urlQuery);
  }, [urlQuery]);
  const [mode, setMode] = useState('titles'); // titles | smart
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const smartQuery = useDebouncedValue(query.trim(), 500);
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const search = useDebouncedValue(query.trim(), 300);
  const requestId = useRef(0);


  const load = useCallback(
    async ({ silent = false } = {}) => {
      const id = ++requestId.current;
      if (!silent) setLoading(true);
      try {
        const result = await sourceService.listSources({
          search: search || undefined,
          kind: type === 'all' ? undefined : type,
          status: status || undefined,
          page,
          limit: PAGE_SIZE,
        });
        if (id === requestId.current) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (id === requestId.current) setError(err);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [search, type, status, page]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [search, type, status]);

  // Keep processing items fresh without a full reload.
  const hasProcessing = data?.items?.some((item) => isInProgress(item.status));
  useEffect(() => {
    if (!hasProcessing) return undefined;
    const timer = setInterval(() => load({ silent: true }), REFRESH_WHILE_PROCESSING_MS);
    return () => clearInterval(timer);
  }, [hasProcessing, load]);

  const filtered = Boolean(search || status || type !== 'all');
  const items = useMemo(() => sortItems(data?.items ?? [], sort), [data, sort]);
  const multiPage = (data?.totalPages ?? 1) > 1;

  let content;
  if (mode === 'smart') {
    content = (
      <SmartSearchResults
        query={smartQuery}
        kind={type === 'all' ? undefined : type}
        from={from || undefined}
        to={to || undefined}
      />
    );
  } else if (loading && !data) {
    content = <SourceListSkeleton />;
  } else if (error && !data) {
    content = (
      <EmptyState
        className="py-16"
        icon={AlertCircle}
        title="Could not load your library"
        description={getErrorMessage(error)}
        action={
          <Button variant="secondary" size="sm" onClick={() => load()}>
            Try again
          </Button>
        }
      />
    );
  } else if (items.length === 0) {
    content = (
      <EmptyState
        className="py-16"
        icon={LibraryIcon}
        title={filtered ? 'No matching summaries' : 'Your library is empty'}
        description={
          filtered
            ? 'Try a different search term or clear the filters.'
            : 'Summaries you create are saved here automatically, so you can search them and come back to them later.'
        }
        action={
          filtered ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setQuery('');
                setStatus('');
                setType('all');
              }}
            >
              Clear filters
            </Button>
          ) : (
            <ButtonLink to="/summarize" variant="secondary" size="sm">
              Summarize something
            </ButtonLink>
          )
        }
      />
    );
  } else {
    content = (
      <>
        <ul className={cn('-mx-3 divide-y divide-stone-200/70', loading && 'opacity-60')} aria-busy={loading || undefined}>
          {items.map((item) => (
            <SourceRow key={item.id} item={item} />
          ))}
        </ul>
        {data.totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 py-4 text-sm text-stone-500">
            <span>
              Page {data.page} of {data.totalPages} · {data.total} summaries
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

  const summaryCount = data?.total ?? null;

  return (
    <PageContainer
      eyebrow="Your collection"
      title="Library"
      description="Everything you have read with Briefly: summaries, takeaways and the source text behind them."
      actions={
        <ButtonLink to="/summarize" variant="secondary">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add source
        </ButtonLink>
      }
    >
      <div className="mb-6 space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <Segmented
            label="Search mode"
            value={mode}
            onChange={setMode}
            options={[
              { id: 'titles', label: 'Titles' },
              { id: 'smart', label: 'Smart search', icon: Sparkles },
            ]}
          />
          <Input
            aria-label={mode === 'smart' ? 'Smart search' : 'Search library'}
            type="search"
            placeholder={mode === 'smart' ? 'Describe what you are looking for' : 'Search by title, site or URL'}
            leadingIcon={mode === 'smart' ? Sparkles : Search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={mode === 'smart' ? 300 : 100}
            className="md:max-w-md md:flex-1"
          />
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div role="group" aria-label="Filter by content type" className="flex flex-wrap gap-1.5">
            {TYPE_FILTERS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={type === id}
                onClick={() => setType(id)}
                className={cn(
                  'h-8 rounded-full px-3.5 text-xs font-medium transition-colors duration-150',
                  type === id ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-150 hover:text-stone-900'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === 'smart' ? (
            <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500">
              <label className="flex items-center gap-2">
                From
                <input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} className="control h-9 w-auto" />
              </label>
              <label className="flex items-center gap-2">
                To
                <input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} className="control h-9 w-auto" />
              </label>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-xs text-stone-500">
              <span aria-live="polite">
                {summaryCount !== null ? `${summaryCount} ${summaryCount === 1 ? 'item' : 'items'}` : ''}
                {summaryCount !== null && multiPage && sort !== 'newest' ? ' · sorted within this page' : ''}
              </span>
              <Select aria-label="Sort" value={sort} onChange={(event) => setSort(event.target.value)} className="h-9 w-auto text-xs">
                {SORTS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)} className="h-9 w-auto text-xs">
                {STATUS_FILTERS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-stone-900/80">{content}</div>
    </PageContainer>
  );
}
