import { useState } from 'react';
import { CloudOff } from 'lucide-react';
import Button from './Button';
import { useAuth } from '../../hooks/useAuth';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

/**
 * The server could not be reached while restoring the session (for example it is still starting
 * after sleeping). This is not a sign-out: the session cookie is kept and "Try again" restores it.
 */
export default function ServerUnavailable() {
  useDocumentTitle('Starting up');
  const { retryConnection } = useAuth();
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      await retryConnection();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 px-5">
      <div className="max-w-sm text-center">
        <CloudOff className="mx-auto h-8 w-8 text-stone-400" aria-hidden="true" />
        <h1 className="mt-4 font-serif text-2xl font-medium text-stone-900">Briefly is still starting</h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          The server is waking up or briefly unavailable. You are still signed in; try again in a moment.
        </p>
        <Button className="mt-6" onClick={retry} loading={busy}>
          Try again
        </Button>
      </div>
    </main>
  );
}
