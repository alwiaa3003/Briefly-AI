import { useEffect, useState } from 'react';
import Spinner from './Spinner';
import { subscribeToServerWake } from '../../services/apiClient';

/**
 * Shown while requests wait for a sleeping server to start (free hosting sleeps when idle).
 * It appears only after a short delay, so a single slow request does not flash it.
 */
export default function ServerWakeNotice({ showAfterMs = 1500 }) {
  const [waking, setWaking] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => subscribeToServerWake(setWaking), []);

  useEffect(() => {
    if (!waking) {
      setVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => setVisible(true), showAfterMs);
    return () => clearTimeout(timer);
  }, [waking, showAfterMs]);

  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-md items-start gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3 shadow-popover"
      >
        <Spinner size="sm" className="mt-0.5 text-brand-600" />
        <div>
          <p className="text-sm font-medium text-stone-900">Briefly is waking up</p>
          <p className="mt-0.5 text-xs leading-relaxed text-stone-600">
            The server sleeps when nobody is using it and takes up to a minute to start. Your request will continue
            automatically.
          </p>
        </div>
      </div>
    </div>
  );
}
