import Logo from '../common/Logo';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

const POINTS = [
  'Summaries of articles, videos and documents',
  'Answers grounded in your own sources, with citations',
  'Notes, flashcards and quizzes when you need to study',
];

export default function AuthLayout({ title, subtitle, children, footer }) {
  useDocumentTitle(title);

  return (
    <div className="grid min-h-screen bg-stone-50 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="hidden flex-col justify-between bg-stone-100 px-12 py-10 lg:flex">
        <Logo />
        <div className="max-w-md">
          <p className="font-serif text-[2.25rem] font-medium leading-[1.15] tracking-[-0.015em] text-stone-900">
            Read less. Understand more.
          </p>
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-stone-600">
            Briefly is a quiet workspace for everything you want to learn from, so you can read, keep and study it in one place.
          </p>
          <ul className="mt-8 space-y-3">
            {POINTS.map((point) => (
              <li key={point} className="flex items-start gap-3 text-sm text-stone-600">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand-500" aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-stone-500">AI-generated content can be wrong. Briefly always links back to the source.</p>
      </aside>

      <div className="flex flex-col">
        <div className="px-6 py-6 sm:px-10 lg:hidden">
          <Logo />
        </div>
        <main className="flex flex-1 items-start justify-center px-5 pb-16 pt-6 sm:items-center sm:pt-0">
          <div className="w-full max-w-[380px]">
            <div className="mb-8">
              <h1 className="page-title">{title}</h1>
              {subtitle && <p className="mt-2.5 text-[0.9375rem] text-stone-500">{subtitle}</p>}
            </div>
            {children}
            {footer && <div className="mt-8 border-t border-stone-200 pt-6 text-sm text-stone-500">{footer}</div>}
          </div>
        </main>
      </div>
    </div>
  );
}
