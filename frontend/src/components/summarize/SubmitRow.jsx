import { ArrowRight } from 'lucide-react';
import Button from '../common/Button';

export default function SubmitRow({ disabled, loading, note, label = 'Summarize', extra }) {
  return (
    <div className="flex flex-col gap-3 border-t border-stone-200/70 pt-5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-stone-500">{note}</p>
      <div className="flex items-center gap-2">
        {extra}
        <Button type="submit" disabled={disabled} loading={loading}>
          {label}
          {!loading && !disabled && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}
