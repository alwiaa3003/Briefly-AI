import { useEffect, useState } from 'react';
import { ExternalLink, FileText } from 'lucide-react';
import Spinner from '../common/Spinner';
import * as sourceService from '../../services/sourceService';
import { safeExternalUrl } from '../../utils/format';

/**
 * The original PDF in the browser's built-in viewer, from a short-lived signed
 * URL that only the owner can obtain. `page` jumps to a page (#page=N).
 */
export default function OriginalViewer({ source, page }) {
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    sourceService
      .getOriginal(source.id)
      .then((original) => !cancelled && setState({ status: 'ready', url: safeExternalUrl(original.url) }))
      .catch(
        (error) =>
          !cancelled &&
          setState({
            status: error.response?.status === 410 ? 'expired' : 'error',
            message: error.response?.data?.error?.message || 'The original file could not be loaded.',
          })
      );
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  if (state.status === 'loading') {
    return (
      <div className="flex h-[70vh] items-center justify-center rounded-xl border border-stone-200 bg-stone-50 text-stone-400">
        <Spinner size="lg" label="Loading the original document" />
      </div>
    );
  }
  if (state.status !== 'ready' || !state.url) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-xl border border-stone-200 bg-stone-50 px-6 text-center">
        <FileText className="h-6 w-6 text-stone-300" aria-hidden="true" />
        <p className="text-sm text-stone-600">{state.message}</p>
        {state.status === 'expired' && <p className="text-xs text-stone-500">Use the Extracted text tab to read the document.</p>}
      </div>
    );
  }

  const src = page ? `${state.url}#page=${page}` : state.url;
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <a href={src} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-medium text-stone-500 hover:text-stone-800">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          Open in a new tab
        </a>
      </div>
      <iframe
        key={src}
        title={`Original document${page ? `, page ${page}` : ''}`}
        src={src}
        className="h-[75vh] w-full rounded-xl border border-stone-200 bg-white"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
