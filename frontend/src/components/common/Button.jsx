import { forwardRef } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../utils/cn';
import Spinner from './Spinner';

const VARIANTS = {
  // Charcoal primary: confident without a loud accent colour.
  primary: 'bg-stone-900 text-white hover:bg-stone-800 active:bg-stone-950 disabled:bg-stone-900/40',
  secondary:
    'bg-white text-stone-800 border border-stone-200 hover:border-stone-300 hover:bg-stone-50 active:bg-stone-100 disabled:text-stone-400',
  ghost: 'text-stone-600 hover:bg-stone-100 hover:text-stone-900 active:bg-stone-150 disabled:text-stone-400',
  danger: 'bg-white text-red-700 border border-red-200 hover:bg-red-50 disabled:text-red-300',
};

const SIZES = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
};

export function buttonClasses({ variant = 'primary', size = 'md', className } = {}) {
  return cn(
    'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-medium',
    'transition-colors duration-150 ease-calm disabled:cursor-not-allowed',
    VARIANTS[variant],
    SIZES[size],
    className
  );
}

/** A router link styled as a button. */
export function ButtonLink({ variant = 'primary', size = 'md', className, children, ...props }) {
  return (
    <Link className={buttonClasses({ variant, size, className })} {...props}>
      {children}
    </Link>
  );
}

const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, className, children, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, className })}
      {...props}
    >
      {loading && <Spinner size="sm" className={variant === 'primary' ? 'text-white' : 'text-stone-500'} />}
      {children}
    </button>
  );
});

export default Button;
