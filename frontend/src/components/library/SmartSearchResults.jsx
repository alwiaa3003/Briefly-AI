import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, SearchX, Sparkles } from 'lucide-react';
import EmptyState from '../common/EmptyState';
import Button from '../common/Button';
import SourceListSkeleton from './SourceListSkeleton';
import * as aiService from '../../services/aiService';
import { CONTENT_TYPES } from '../../utils/contentTypes';
import { getErrorMessage } from '../../utils/errors';
import { formatShortDate } from '../../utils/format';

const KIND_LABEL = Object.fromEntries(CONTENT_TYPES.map((t) => [t.id, t.singular || t.label]));

function locationOf(match) {
  return match.label || (match.page ? `p. ${match.page}` : null);
}

/** Semantic + keyword search results, grouped by source with matching passages. */
export default function SmartSearchResults({ query, kind, from, to }) {
  const [state, setState] = useState({ loading: false, data: null, error: null });
  const requestId = useRef(0);

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const data = await aiService.searchLibrary({ q: query, kind, from, to, limit: 15 });
      if (id === requestId.current) setState({ loading: false, data, error: null });
    } catch (error) {
      if (id === requestId.current) setState({ loading: false, data: null, error });
    }
  }, [query, kind, from, to]);

  useEffect(() => {
    if (query.length < 2) {
      requestId.current += 1;
      setState({ loading: false, data: null, error: null });
      return;
    }
    run();
  }, [query, run]);

  if (query.length < 2) {
    return (
      <EmptyState
        className="py-16"
        icon={Sparkles}
        title="Search by meaning"
        description='Describe what you are looking for in your own words, e.g. "how trees cool cities" or "the meeting about budgets". Briefly searches inside every summary, transcript and document.'
      />
    );
  }
  if (state.loading && !state.data) return <SourceListSkeleton />;
  if (state.error) {
    return (
      <EmptyState
        className="py-16"
        icon={AlertCircle}
        title="Search failed"
        description={getErrorMessage(state.error)}
        action={
          <Button variant="secondary" size="sm" onClick={run}>
            Try again
          </Button>
        }
      />
    );
  }
  const results = state.data?.results || [];
  if (!results.length) {
    return <EmptyState className="py-16" icon={SearchX} title="No matches" description="Try other words, or clear the type and date filters." />;
  }

  return (
    <div aria-busy={state.loading || undefined} className={state.loading ? 'opacity-60' : undefined}>
      {state.data.mode === 'keyword' && (
        <p className="border-b border-stone-200/70 bg-stone-50 px-5 py-2 text-xs text-stone-500">
          Showing keyword matches only. Meaning-based search is temporarily unavailable.
        </p>
      )}
      <ul className="divide-y divide-stone-200/70">
        {results.map((r) => (
          <li key={r.source.id}>
            <Link to={`/library/${r.source.id}`} className="block px-5 py-4 hover:bg-stone-50">
              <div className="flex items-center gap-2 text-2xs text-stone-500">
                <span className="font-medium uppercase tracking-wide">{KIND_LABEL[r.source.kind] || r.source.kind}</span>
                <span aria-hidden="true">·</span>
                <span>{formatShortDate(r.source.createdAt)}</span>
                {r.source.siteName && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{r.source.siteName}</span>
                  </>
                )}
              </div>
              <p className="mt-1 text-sm font-semibold text-stone-900">{r.source.title}</p>
              {r.matches.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {r.matches.map((m, i) => (
                    <li key={i} className="flex gap-2 text-sm text-stone-600">
                      {locationOf(m) && (
                        <span className="mt-0.5 shrink-0 rounded bg-stone-100 px-1.5 py-px text-2xs font-medium tabular-nums text-stone-600">
                          {locationOf(m)}
                        </span>
                      )}
                      <span className="line-clamp-2">{m.snippet}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                r.overview && <p className="mt-1 line-clamp-2 text-sm text-stone-600">{r.overview}</p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
