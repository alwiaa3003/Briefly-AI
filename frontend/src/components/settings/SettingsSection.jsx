import { NavLink } from 'react-router-dom';
import { cn } from '../../utils/cn';

/**
 * Editorial settings section: a thin rule, the heading and its description on the left,
 * controls on the right (stacked on small screens). Same API as Card / CardHeader / CardBody.
 */
export function Section({ as: Component = 'section', className, children, ...props }) {
  return (
    <Component className={cn('grid gap-5 border-t border-stone-200 py-8 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-10', className)} {...props}>
      {children}
    </Component>
  );
}

export function SectionHeader({ title, description, action, className }) {
  return (
    <div className={cn('min-w-0', className)}>
      <h2 className="font-serif text-lg font-medium text-stone-900">{title}</h2>
      {description && <p className="mt-1 text-sm leading-relaxed text-stone-500">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function SectionBody({ className, children }) {
  return <div className={cn('min-w-0', className)}>{children}</div>;
}

const LINKS = [
  { to: '/settings', label: 'Account' },
  { to: '/usage', label: 'AI usage' },
];

/** Contextual navigation between the account pages. */
export function SettingsNav() {
  return (
    <nav aria-label="Account pages" className="mb-2 flex gap-6 border-b border-stone-200">
      {LINKS.map(({ to, label }) => (
        <NavLink
          key={to}
          to={to}
          end
          className={({ isActive }) =>
            cn(
              '-mb-px border-b-[1.5px] pb-3 text-sm font-medium transition-colors',
              isActive ? 'border-stone-900 text-stone-900' : 'border-transparent text-stone-600 hover:text-stone-900'
            )
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
