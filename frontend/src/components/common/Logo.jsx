import { cn } from '../../utils/cn';

/** Briefly mark: three lines condensing into a short accent line (a summary). */
export function LogoMark({ className }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('h-7 w-7', className)} aria-hidden="true">
      <rect width="32" height="32" rx="9" className="fill-stone-900" />
      <path d="M9.5 10.5h13M9.5 16h9" stroke="#F7F5F0" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M9.5 21.5h5" stroke="#BE8D74" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export default function Logo({ className }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="font-serif text-[1.3125rem] font-medium tracking-[-0.01em] text-stone-900">Briefly</span>
    </span>
  );
}
