import { cn } from '../../utils/cn';

/** A quiet surface. Use sparingly: most content sits directly on the page. */
export function Card({ as: Component = 'section', className, children, ...props }) {
  return (
    <Component className={cn('rounded-lg border border-stone-200 bg-white', className)} {...props}>
      {children}
    </Component>
  );
}

export function CardHeader({ title, description, action, className }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pb-1 pt-5 sm:px-6', className)}>
      <div className="min-w-0">
        <h2 className="text-[0.9375rem] font-semibold text-stone-900">{title}</h2>
        {description && <p className="mt-1 text-sm leading-relaxed text-stone-500">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardBody({ className, children }) {
  return <div className={cn('px-5 py-5 sm:px-6', className)}>{children}</div>;
}

export default Card;
