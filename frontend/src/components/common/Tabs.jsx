import { cn } from '../../utils/cn';

/**
 * Underline tabs (WAI-ARIA tablist). Each tab: { id, label, icon?, shortLabel? }.
 * Ids of tabs and panels follow `${idPrefix}tab-${id}` / `${idPrefix}panel-${id}`.
 */
export function TabList({ tabs, value, onChange, label, idPrefix = '', className }) {
  function handleKey(event, index) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    onChange(tabs[next].id);
    document.getElementById(`${idPrefix}tab-${tabs[next].id}`)?.focus();
  }
  return (
    <div role="tablist" aria-label={label} className={cn('flex gap-5 overflow-x-auto border-b border-stone-200 sm:gap-7', className)}>
      {tabs.map(({ id, label: tabLabel, shortLabel, icon: Icon }, index) => {
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${idPrefix}tab-${id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}panel-${id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={(event) => handleKey(event, index)}
            className={cn(
              '-mb-px inline-flex shrink-0 items-center gap-2 border-b-[1.5px] pb-3 pt-1 text-sm font-medium transition-colors duration-150',
              selected ? 'border-stone-900 text-stone-900' : 'border-transparent text-stone-600 hover:text-stone-900'
            )}
          >
            {Icon && <Icon className={cn('h-4 w-4', shortLabel && 'hidden sm:block', selected ? 'text-stone-700' : 'text-stone-400')} aria-hidden="true" />}
            {shortLabel ? (
              <>
                <span className="hidden sm:inline">{tabLabel}</span>
                <span className="sm:hidden">{shortLabel}</span>
              </>
            ) : (
              tabLabel
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented control for small option sets (filters, modes). */
export function Segmented({ options, value, onChange, label, className }) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex rounded-lg bg-stone-100 p-0.5', className)}>
      {options.map(({ id, label: optionLabel, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors duration-150',
            value === id ? 'bg-white text-stone-900 shadow-card ring-1 ring-stone-200' : 'text-stone-600 hover:text-stone-900'
          )}
        >
          {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
          {optionLabel}
        </button>
      ))}
    </div>
  );
}
