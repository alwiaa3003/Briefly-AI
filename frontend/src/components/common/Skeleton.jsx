import { cn } from '../../utils/cn';

/** Neutral placeholder block shown while content loads. */
export default function Skeleton({ className }) {
  return <div aria-hidden="true" className={cn('animate-pulse rounded-md bg-stone-200/70', className)} />;
}
