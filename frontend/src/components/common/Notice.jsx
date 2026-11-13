import { AlertCircle, Info } from 'lucide-react';
import { cn } from '../../utils/cn';

const VARIANTS = {
  info: { container: 'bg-stone-100/70 text-stone-700', icon: Info, iconClass: 'text-stone-500' },
  error: { container: 'bg-red-50 text-red-800', icon: AlertCircle, iconClass: 'text-red-600' },
};

/** Inline message block, e.g. form-level errors, paused work or explanations. */
export default function Notice({ variant = 'info', title, children, className }) {
  const { container, icon: Icon, iconClass } = VARIANTS[variant];
  return (
    <div role={variant === 'error' ? 'alert' : 'note'} className={cn('flex gap-3 rounded-lg px-4 py-3', container, className)}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconClass)} aria-hidden="true" />
      <div className="min-w-0 text-sm leading-relaxed">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
      </div>
    </div>
  );
}
