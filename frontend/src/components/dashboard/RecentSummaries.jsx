import { Link } from 'react-router-dom';
import { AlertCircle, History } from 'lucide-react';
import EmptyState from '../common/EmptyState';
import Button from '../common/Button';
import SourceRow from '../library/SourceRow';
import SourceListSkeleton from '../library/SourceListSkeleton';
import { getErrorMessage } from '../../utils/errors';

/** "Continue exploring": the user's most recent sources (real data from /api/sources). */
export default function RecentSummaries({ items, loading, error, onRetry }) {
  let body;
  if (loading && !items) {
    body = <SourceListSkeleton rows={3} />;
  } else if (error && !items) {
    body = (
      <EmptyState
        icon={AlertCircle}
        title="Could not load your recent reading"
        description={getErrorMessage(error)}
        action={
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  } else if (!items || items.length === 0) {
    body = (
      <EmptyState
        icon={History}
        title="Nothing here yet"
        description="When you summarize something, it appears here so you can pick up where you left off."
      />
    );
  } else {
    body = (
      <ul className="-mx-3 divide-y divide-stone-200/70">
        {items.map((item) => (
          <SourceRow key={item.id} item={item} showReady />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="recent-heading" className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-4 border-b border-stone-900/80 pb-3">
        <h2 id="recent-heading" className="font-serif text-2xl font-medium text-stone-900">
          Continue exploring
        </h2>
        <Link to="/library" className="text-sm text-stone-500 underline-offset-4 hover:text-stone-900 hover:underline">
          View library
        </Link>
      </div>
      {body}
    </section>
  );
}
