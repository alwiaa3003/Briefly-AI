import { Check } from 'lucide-react';
import Spinner from '../common/Spinner';
import { processingSteps, progressLabel } from '../../utils/sourceStatus';
import { cn } from '../../utils/cn';

// Steps that can show fine-grained progress, and the progress stage they belong to.
const PROGRESS_STEPS = {
  transcribing: { stage: null, label: 'Transcription progress' },
  extracting: { stage: 'ocr', label: 'Text recognition progress' },
  summarizing: { stage: 'chunks', label: 'Summarization progress' },
};

/** Vertical progress indicator. Steps depend on the kind of source (article, video, document). */
export default function ProcessingSteps({ status, job, kind = 'article', progress, source = null }) {
  const steps = processingSteps(kind, source);
  const activeIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === status)
  );
  const retrying = job && job.attempts > 1 && status !== 'completed';

  return (
    <div>
      <ol className="space-y-0" aria-label="Processing progress">
        {steps.map((step, index) => {
          const done = index < activeIndex || status === 'completed';
          const current = index === activeIndex && status !== 'completed';
          const progressStep = PROGRESS_STEPS[step.id];
          const showProgress =
            current && progressStep && progressLabel(progress) && (progressStep.stage === null || progress.stage === progressStep.stage);
          return (
            <li key={step.id} className="relative flex gap-3 pb-5 last:pb-0" aria-current={current ? 'step' : undefined}>
              {index < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn('absolute left-[11px] top-6 h-[calc(100%-1.25rem)] w-px', done ? 'bg-brand-300' : 'bg-stone-200')}
                />
              )}
              <span
                className={cn(
                  'relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold',
                  done && 'border-brand-600 bg-brand-600 text-white',
                  current && 'border-brand-500 bg-white text-brand-700',
                  !done && !current && 'border-stone-300 bg-white text-stone-500'
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : current ? <Spinner size="sm" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className={cn('text-sm font-medium', current || done ? 'text-stone-900' : 'text-stone-500')}>{step.label}</p>
                {current && <p className="mt-0.5 text-xs text-stone-500">{step.description}</p>}
                {showProgress && (
                  <div className="mt-2 max-w-xs">
                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-stone-100"
                      role="progressbar"
                      aria-label={progressStep.label}
                      aria-valuemin={0}
                      aria-valuemax={progress.total}
                      aria-valuenow={progress.current}
                    >
                      <div
                        className="h-full rounded-full bg-brand-500 transition-[width]"
                        style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-2xs text-stone-500">{progressLabel(progress)}</p>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {retrying && (
        <p className="mt-4 text-xs text-amber-700">
          A temporary problem occurred, so Briefly is retrying (attempt {job.attempts} of {job.maxAttempts}).
        </p>
      )}
    </div>
  );
}
