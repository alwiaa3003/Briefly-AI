import { cn } from '../../utils/cn';

/** Small status / type label. Muted tones; colour only where it carries meaning. */
const VARIANTS = {
  neutral: 'bg-stone-100 text-stone-600',
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-emerald-50 text-emerald-800',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
};

export default function Badge({ variant = 'neutral', className, children }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium', VARIANTS[variant], className)}>
      {children}
    </span>
  );
}
