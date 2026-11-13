import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { cn } from '../../utils/cn';

const WIDTHS = {
  default: 'max-w-page',
  narrow: 'max-w-3xl',
  reading: 'max-w-reading',
};

/** Consistent page header: optional eyebrow, serif title, short description, actions. */
export function PageHeader({ eyebrow, title, description, actions, className }) {
  return (
    <header className={cn('mb-10 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between', className)}>
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        {title && <h1 className="page-title">{title}</h1>}
        {description && <p className="mt-2.5 max-w-2xl text-[0.9375rem] leading-relaxed text-stone-500">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Page wrapper with the shared content width and spacing. */
export default function PageContainer({ eyebrow, title, description, actions, children, className, documentTitle, width = 'default' }) {
  useDocumentTitle(documentTitle ?? title);

  return (
    <div className={cn('mx-auto w-full px-5 py-9 sm:px-8 lg:px-12 lg:py-14', WIDTHS[width], className)}>
      {(title || actions) && <PageHeader eyebrow={eyebrow} title={title} description={description} actions={actions} />}
      {children}
    </div>
  );
}
