import Skeleton from '../common/Skeleton';

export default function SourceListSkeleton({ rows = 4 }) {
  return (
    <ul role="status" aria-label="Loading summaries" className="divide-y divide-stone-200/70">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index} className="flex gap-4 px-5 py-4">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </li>
      ))}
    </ul>
  );
}
