import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../../utils/cn';

const ICONS = {
  // Toasts sit on a charcoal surface, so icons use light tints.
  success: { icon: CheckCircle2, className: 'text-emerald-300' },
  error: { icon: AlertCircle, className: 'text-red-300' },
  info: { icon: Info, className: 'text-stone-300' },
};

export default function ToastViewport({ toasts, onDismiss }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
    >
      {toasts.map((toast) => {
        const { icon: Icon, className } = ICONS[toast.variant] || ICONS.info;
        return (
          <div
            key={toast.id}
            role={toast.variant === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl bg-stone-900 px-4 py-3 text-white shadow-popover"
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', className)} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{toast.title}</p>
              {toast.description && <p className="mt-0.5 text-sm text-stone-300">{toast.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="-mr-1 rounded-md p-1 text-stone-400 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
