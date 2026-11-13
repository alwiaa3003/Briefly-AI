import { createContext, useCallback, useMemo, useRef, useState } from 'react';
import ToastViewport from '../components/common/ToastViewport';

export const ToastContext = createContext(null);

const DEFAULT_DURATION_MS = 4500;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    ({ title, description, variant = 'info', durationMs = DEFAULT_DURATION_MS }) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, title, description, variant }]);
      if (durationMs > 0) setTimeout(() => dismiss(id), durationMs);
      return id;
    },
    [dismiss]
  );

  const value = useMemo(
    () => ({
      show,
      dismiss,
      success: (title, description) => show({ title, description, variant: 'success' }),
      error: (title, description) => show({ title, description, variant: 'error' }),
      info: (title, description) => show({ title, description, variant: 'info' }),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
