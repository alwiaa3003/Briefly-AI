import { forwardRef, useId } from 'react';
import { cn } from '../../utils/cn';

const Input = forwardRef(function Input({ label, error, hint, id, className, leadingIcon: LeadingIcon, ...props }, ref) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const messageId = `${inputId}-message`;
  const message = error || hint;

  return (
    <div className={className}>
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-stone-700">
          {label}
        </label>
      )}
      <div className="relative">
        {LeadingIcon && (
          <LeadingIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
          />
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          className={cn(
            'control h-10',
            LeadingIcon && 'pl-9',
            error && 'border-red-300 hover:border-red-300 focus:border-red-400 focus:ring-red-100'
          )}
          {...props}
        />
      </div>
      {message && (
        <p id={messageId} className={cn('mt-1.5 text-xs', error ? 'text-red-700' : 'text-stone-500')}>
          {message}
        </p>
      )}
    </div>
  );
});

/** Native select with the shared control styling. */
export const Select = forwardRef(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn('control h-10 w-auto pr-8', className)} {...props}>
      {children}
    </select>
  );
});

export default Input;
