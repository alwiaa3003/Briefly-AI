import { cn } from '../../utils/cn';

export default function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-14 text-center', className)}>
      {Icon && (
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-stone-100">
          <Icon className="h-[1.125rem] w-[1.125rem] text-stone-500" aria-hidden="true" />
        </div>
      )}
      <h3 className="font-serif text-lg font-medium text-stone-900">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-stone-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
