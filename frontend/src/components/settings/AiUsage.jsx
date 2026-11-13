import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import Badge from '../common/Badge';
import Button from '../common/Button';
import Skeleton from '../common/Skeleton';
import * as aiService from '../../services/aiService';
import { getErrorMessage } from '../../utils/errors';

const FEATURE_LABELS = {
  summary: 'Summaries',
  chat: 'Ask AI',
  notes: 'Study notes',
  quiz: 'Quizzes',
  flashcards: 'Flashcards',
  style: 'Summary styles',
  indexing: 'Search indexing',
  search: 'Smart search',
  other: 'Other',
};
const GROUP_LABELS = { summary: 'Summaries', chat: 'Ask AI', study: 'Study tools' };

const STATE = {
  available: { variant: 'success', label: 'Available' },
  unknown: { variant: 'neutral', label: 'Not used yet today' },
  rate_limited: { variant: 'warning', label: 'Rate-limited' },
  quota_exhausted: { variant: 'danger', label: 'Free quota used up' },
  unavailable: { variant: 'danger', label: 'Unavailable (configuration)' },
};

function formatWhen(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }).format(new Date(iso));
}

function Meter({ label, used, limit }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-stone-700">{label}</span>
        <span className="tabular-nums text-stone-500">
          {used} / {limit} <span className="text-xs">({Math.max(0, limit - used)} left)</span>
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-stone-200"
        role="progressbar"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
      >
        <div className={`h-full rounded-full ${pct >= 90 ? 'bg-brand-700' : pct >= 70 ? 'bg-brand-400' : 'bg-stone-700'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProviderRow({ label, status }) {
  const state = STATE[status?.state] || STATE.unknown;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span className="text-stone-700">
        {label} <span className="text-xs text-stone-500">({status?.model || 'unknown model'})</span>
      </span>
      <span className="flex items-center gap-2">
        <Badge variant={state.variant}>{state.label}</Badge>
        {status?.until && (
          <span className="text-xs text-stone-500">
            {status.untilSource === 'provider' ? 'Gemini asked to wait until' : 'Retrying after'} {formatWhen(status.until)}
          </span>
        )}
      </span>
    </div>
  );
}

/** AI usage page: Briefly's own budgets and today's usage. Google's quotas are only visible in AI Studio. */
export default function AiUsage() {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsage(await aiService.getUsage());
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const features = Object.entries(usage?.app?.byFeature || {}).filter(([, v]) => v.generation || v.embedding);

  return (
    <div className="space-y-10">
      <div className="flex items-center justify-between gap-4">
        <p className="max-w-xl text-sm leading-relaxed text-stone-500">
          Briefly&rsquo;s own daily limits for the free Gemini tier, and how much of them has been used today.
        </p>
        <Button variant="secondary" size="sm" onClick={load} loading={loading} aria-label="Refresh AI usage">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Refresh
        </Button>
      </div>

        {error && !usage ? (
          <p className="text-sm text-red-600">{getErrorMessage(error)}</p>
        ) : !usage ? (
          <div className="space-y-3" role="status" aria-label="Loading AI usage">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <>
            <section aria-label="Gemini status">
              <h2 className="eyebrow mb-2">Gemini status</h2>
              <div className="divide-y divide-stone-200/70">
                <ProviderRow label="Text generation" status={usage.provider.generation} />
                <ProviderRow label="Embeddings (search)" status={usage.provider.embedding} />
              </div>
            </section>

            <section aria-label="Application budget" className="space-y-3">
              <h2 className="eyebrow">Briefly budget today (all users)</h2>
              <Meter label="AI generations" used={usage.app.generation.used} limit={usage.app.generation.limit} />
              {Object.entries(usage.app.features).map(([group, b]) => (
                <Meter key={group} label={`· ${GROUP_LABELS[group] || group}`} used={b.used} limit={b.limit} />
              ))}
              <Meter label="Embedding requests" used={usage.app.embedding.used} limit={usage.app.embedding.limit} />
            </section>

            <section aria-label="Your usage" className="space-y-3">
              <h2 className="eyebrow">Your usage today</h2>
              <Meter label="Your AI generations" used={usage.user.generation.used} limit={usage.user.generation.limit} />
            </section>

            {features.length > 0 && (
              <section aria-label="Requests by feature">
                <h2 className="eyebrow mb-3">Requests by feature (today)</h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500">
                      <th className="py-1 font-medium">Feature</th>
                      <th className="py-1 text-right font-medium">Generations</th>
                      <th className="py-1 text-right font-medium">Embeddings</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-200/70">
                    {features.map(([feature, v]) => (
                      <tr key={feature}>
                        <td className="py-1.5 text-stone-700">{FEATURE_LABELS[feature] || feature}</td>
                        <td className="py-1.5 text-right tabular-nums">{v.generation || 0}</td>
                        <td className="py-1.5 text-right tabular-nums">{v.embedding || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <p className="text-xs leading-relaxed text-stone-500">
              Budgets reset daily at midnight ({usage.timeZone}). {usage.note} Free-tier availability and limits are set by
              Google and can change.{' '}
              <a
                href="https://aistudio.google.com/rate-limit"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 font-medium text-brand-700 hover:underline"
              >
                Open AI Studio quotas
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </p>
          </>
        )}
    </div>
  );
}
