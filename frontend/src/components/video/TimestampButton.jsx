import { formatTimestamp } from '../../utils/format';

/** A timestamp that seeks the player. */
export default function TimestampButton({ seconds, onSeek, className = '' }) {
  const label = formatTimestamp(seconds);
  return (
    <button
      type="button"
      onClick={() => onSeek(seconds)}
      className={`shrink-0 rounded-md bg-brand-50 px-1.5 py-0.5 font-mono text-xs font-medium tabular-nums text-brand-700 hover:bg-brand-100 ${className}`}
      aria-label={`Play from ${label}`}
    >
      {label}
    </button>
  );
}
