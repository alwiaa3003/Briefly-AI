/**
 * Page / section references. Every value shown here was validated against the
 * document's extracted text on the server; nothing is computed in the browser.
 */
export default function RefChips({ refs, onSelect }) {
  const pages = refs?.pages || [];
  const section = refs?.section || null;
  if (!pages.length && !section) return null;

  return (
    <span className="ml-1 inline-flex flex-wrap items-center gap-1 align-middle">
      {pages.map((page) => (
        <button
          key={page}
          type="button"
          onClick={() => onSelect({ page })}
          className="rounded bg-stone-100 px-1.5 py-px text-2xs font-medium tabular-nums text-stone-600 hover:bg-brand-50 hover:text-brand-700"
          aria-label={`Go to page ${page}`}
        >
          p. {page}
        </button>
      ))}
      {section && (
        <button
          type="button"
          onClick={() => onSelect({ section })}
          className="max-w-[14rem] truncate rounded bg-stone-100 px-1.5 py-px text-2xs font-medium text-stone-600 hover:bg-brand-50 hover:text-brand-700"
          aria-label={`Go to section ${section}`}
        >
          § {section}
        </button>
      )}
    </span>
  );
}
