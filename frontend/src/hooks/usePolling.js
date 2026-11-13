import { useEffect, useRef } from 'react';

/** Calls `fn` every `intervalMs` while `active` is true (used for background generations). */
export function usePolling(fn, active, intervalMs = 2500) {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => saved.current(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
}
