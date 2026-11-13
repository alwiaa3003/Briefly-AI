import { useEffect, useRef, useState } from 'react';
import { cn } from '../../utils/cn';

/*
 * Editorial reading primitives shared by article, video and document summaries.
 * Sections are separated by rhythm and hairlines rather than cards.
 */

export function SectionTitle({ id, children }) {
  return (
    <h2 id={id} data-toc="" className="eyebrow scroll-mt-24">
      {children}
    </h2>
  );
}

/** Main-column section of the reading workspace. */
export function ReadingSection({ className, children, ...props }) {
  return (
    <section className={cn('border-t border-stone-200/70 pt-7 first:border-t-0 first:pt-0', className)} {...props}>
      {children}
    </section>
  );
}

/** Side-rail section (takeaways, concepts, source details). */
export function RailSection({ className, children, ...props }) {
  return (
    <section className={cn('border-t border-stone-200/80 pt-5', className)} {...props}>
      {children}
    </section>
  );
}

/** Two-column reading layout: content and a sticky rail on wide screens. */
export function ReadingLayout({ children, rail }) {
  return (
    <div data-reading="" className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_17.5rem] xl:items-start">
      <div className="min-w-0 max-w-reading space-y-9">{children}</div>
      <aside className="space-y-7 xl:sticky xl:top-24">
        <OnThisPage />
        {rail}
      </aside>
    </div>
  );
}

/** "On this page": links to the main-column section headings of the enclosing [data-reading] layout. */
export function OnThisPage() {
  const ref = useRef(null);
  const [items, setItems] = useState([]);
  useEffect(() => {
    const root = ref.current?.closest('[data-reading]');
    if (!root) return;
    const headings = [...root.querySelectorAll('[data-toc][id]')].filter((h) => !h.closest('aside'));
    setItems(headings.map((h) => ({ id: h.id, label: h.textContent })));
  }, []);
  if (items.length < 2) return <span ref={ref} hidden />;
  return (
    <nav ref={ref} aria-label="On this page" className="hidden xl:block">
      <p className="eyebrow mb-2">On this page</p>
      <ul className="space-y-1 border-l border-stone-200">
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(item.id)?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
              }}
              className="-ml-px block border-l border-transparent py-0.5 pl-3 text-sm text-stone-500 transition-colors hover:border-stone-400 hover:text-stone-900"
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Paragraphs({ text, className }) {
  return String(text || '')
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((paragraph, index) => (
      <p key={index} className={className}>
        {paragraph}
      </p>
    ));
}
