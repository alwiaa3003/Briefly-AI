import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import RecentSummaries from '../components/dashboard/RecentSummaries';
import Composer from '../components/summarize/Composer';
import { useAuth } from '../hooks/useAuth';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import * as sourceService from '../services/sourceService';
import { getFirstName } from '../utils/format';

const RECENT_LIMIT = 6;

const STUDY_LINKS = [
  { to: '/study?tool=notes', title: 'Study notes', text: 'Concepts, definitions and revision points.' },
  { to: '/study?tool=flashcards', title: 'Flashcards', text: 'Review the essentials, track what you know.' },
  { to: '/study?tool=quizzes', title: 'Quizzes', text: 'Questions grounded in the source.' },
  { to: '/ask', title: 'Ask AI', text: 'Questions across your library, with citations.' },
];

function greetingFor(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function ActivityLine({ stats }) {
  if (!stats || stats.total === 0) return null;
  const parts = [
    `${stats.completed} ${stats.completed === 1 ? 'summary' : 'summaries'} in your library`,
    stats.processing ? `${stats.processing} in progress` : null,
    stats.failed ? `${stats.failed} need attention` : null,
  ].filter(Boolean);
  return <p className="mt-3 text-sm text-stone-500">{parts.join(' · ')}</p>;
}

function StudyShortcuts() {
  return (
    <section aria-labelledby="study-heading">
      <h2 id="study-heading" className="eyebrow border-b border-stone-200 pb-3">
        Study shortcuts
      </h2>
      <ul className="divide-y divide-stone-200/70">
        {STUDY_LINKS.map(({ to, title, text }) => (
          <li key={to}>
            <Link to={to} className="group flex items-start gap-3 py-3.5">
              <span className="min-w-0 flex-1">
                <span className="block font-serif text-[1.0625rem] font-medium text-stone-900 group-hover:text-brand-700">{title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">{text}</span>
              </span>
              <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 text-stone-400 transition-colors group-hover:text-brand-600" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FirstSteps() {
  const steps = [
    ['Add a source', 'Paste an article or YouTube link, or upload a video or document above.'],
    ['Read the summary', 'Overview, key takeaways, concepts, chapters and page references.'],
    ['Study and ask', 'Generate notes, flashcards and quizzes, or ask questions with citations.'],
  ];
  return (
    <section aria-labelledby="first-steps">
      <h2 id="first-steps" className="border-b border-stone-900/80 pb-3 font-serif text-2xl font-medium text-stone-900">
        Your library is empty, so let&rsquo;s fill it
      </h2>
      <ol className="mt-6 grid gap-8 sm:grid-cols-3">
        {steps.map(([title, text], index) => (
          <li key={title}>
            <span className="font-serif text-3xl italic text-brand-500">{index + 1}</span>
            <p className="mt-2 text-sm font-medium text-stone-900">{title}</p>
            <p className="mt-1 text-sm leading-relaxed text-stone-500">{text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function Dashboard() {
  useDocumentTitle('Home');
  const { user } = useAuth();
  const firstName = getFirstName(user?.name);
  const [method, setMethod] = useState('article');
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statsResult, recentResult] = await Promise.all([
        sourceService.getSourceStats(),
        sourceService.listSources({ limit: RECENT_LIMIT }),
      ]);
      setStats(statsResult);
      setRecent(recentResult.items);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const isNew = stats && stats.total === 0;

  return (
    <div className="mx-auto w-full max-w-page px-5 pb-16 pt-12 sm:px-8 sm:pt-16 lg:px-12 lg:pt-20">
      <header className="max-w-3xl">
        <p className="eyebrow mb-4">
          {greetingFor()}
          {firstName ? `, ${firstName}` : ''}
        </p>
        <h1 className="font-serif text-[2.5rem] font-medium leading-[1.08] tracking-[-0.015em] text-stone-900 sm:text-[3.25rem] lg:text-[3.75rem]">
          A space for better thinking.
        </h1>
        <p className="mt-4 font-serif text-xl italic text-stone-500 sm:text-2xl">Read less passively. Understand more deeply.</p>
        <ActivityLine stats={stats} />
      </header>

      <section aria-labelledby="compose-heading" className="mt-12 max-w-3xl sm:mt-14">
        <h2 id="compose-heading" className="mb-4 text-[0.9375rem] font-medium text-stone-800">
          What would you like to understand today?
        </h2>
        <Composer value={method} onChange={setMethod} idPrefix="home-" />
      </section>

      <div className="mt-16 grid gap-14 sm:mt-20 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-16">
        {isNew ? <FirstSteps /> : <RecentSummaries items={recent} loading={loading} error={error} onRetry={load} />}
        <StudyShortcuts />
      </div>
    </div>
  );
}
