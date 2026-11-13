import { refLabel } from '../../utils/study';

/** Small location chips ("p. 4", "12:30–13:05", "Methods") for a study item. */
export default function SourceRefs({ refs }) {
  const labels = [...new Set((refs || []).map(refLabel).filter(Boolean))];
  if (!labels.length) return null;
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      {labels.map((label) => (
        <span
          key={label}
          className="max-w-[12rem] truncate rounded bg-stone-100 px-1.5 py-px text-2xs font-medium tabular-nums text-stone-600"
          title={`From ${label}`}
        >
          {label}
        </span>
      ))}
    </span>
  );
}
