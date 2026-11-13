import { Clock, Sparkles } from 'lucide-react';
import Button from '../common/Button';
import EmptyState from '../common/EmptyState';
import Notice from '../common/Notice';
import Spinner from '../common/Spinner';

/** Shared empty / generating / failed states for study tools. */
export function GeneratingState({ title, description, item }) {
  // Paused while waiting for AI capacity (quota, Briefly's budget, rate limit): say so instead of spinning.
  const waiting = item?.status === 'queued' && item?.error?.message;
  if (waiting) {
    return (
      <div className="flex flex-col items-center px-6 py-14 text-center" role="status" aria-live="polite">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-200 bg-amber-50">
          <Clock className="h-5 w-5 text-amber-700" aria-hidden="true" />
        </div>
        <p className="mt-4 text-sm font-semibold text-stone-900">Paused: waiting for AI capacity</p>
        <p className="mt-1 max-w-md text-sm text-stone-600">{item.error.message}</p>
        <p className="mt-2 text-xs text-stone-500">Nothing is lost. Your saved content stays available meanwhile.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center" role="status" aria-live="polite">
      <Spinner size="lg" className="text-stone-500" />
      <p className="mt-4 text-sm font-semibold text-stone-900">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-stone-500">{description || 'This usually takes under a minute. You can leave this page.'}</p>
    </div>
  );
}

export function NotGeneratedState({ icon = Sparkles, title, description, actionLabel, onGenerate, busy, children }) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      action={
        <div className="flex flex-col items-center gap-4">
          {children}
          <Button onClick={onGenerate} loading={busy}>
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {actionLabel}
          </Button>
        </div>
      }
    />
  );
}

export function FailedGeneration({ item, onRetry, busy, what = 'This could not be generated' }) {
  return (
    <div className="space-y-4 p-5">
      <Notice variant="error" title={what}>
        {item?.error?.message || 'Something went wrong. Please try again.'}
      </Notice>
      <Button variant="secondary" onClick={onRetry} loading={busy}>
        Try again
      </Button>
    </div>
  );
}
